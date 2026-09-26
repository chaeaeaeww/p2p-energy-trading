import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { CONFIG } from "../config";
import { ENERGY_MARKET_ABI, ENERGY_TOKEN_ABI } from "../lib/abi";
import { errorMessage, pricePerKwhToPerWh } from "../lib/format";

const marketIface = new ethers.Interface(ENERGY_MARKET_ABI);

function plainArgs(parsed) {
  const out = {};
  parsed.fragment.inputs.forEach((input, i) => {
    out[input.name] = parsed.args[i];
  });
  return out;
}

/**
 * Đọc/ghi smart contract EnergyMarket + EnergyToken.
 * - Đọc: qua RPC (VITE_RPC_URL) nếu có, nếu không thì qua MetaMask.
 * - Ghi: luôn ký bằng MetaMask (getSigner từ useWallet).
 * - Truy vết: quét log on-chain từ VITE_DEPLOY_BLOCK và poll block mới.
 */
export function useMarket(wallet) {
  const configured = ethers.isAddress(CONFIG.marketAddress);
  const { account, chainId, getSigner } = wallet;

  const [tokenAddress, setTokenAddress] = useState(ethers.isAddress(CONFIG.tokenAddress) ? CONFIG.tokenAddress : "");
  const [tokenInfo, setTokenInfo] = useState({ symbol: "TOKEN", decimals: 18, name: "" });
  const [currentSlot, setCurrentSlot] = useState(null);
  const [viewSlot, setViewSlot] = useState(null);
  const [orders, setOrders] = useState([]);
  const [events, setEvents] = useState([]);
  const [tokenBalance, setTokenBalance] = useState(null);
  const [myHouseId, setMyHouseId] = useState("");
  const [latestBlock, setLatestBlock] = useState(null);
  const [error, setError] = useState("");
  const [txs, setTxs] = useState([]);
  const [busy, setBusy] = useState(false);

  const syncedTo = useRef(null);

  // Provider chỉ đọc
  const readProvider = useMemo(() => {
    if (CONFIG.rpcUrl) {
      return new ethers.JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });
    }
    if (typeof window !== "undefined" && window.ethereum && chainId === CONFIG.chainId) {
      return new ethers.BrowserProvider(window.ethereum);
    }
    return null;
  }, [chainId]);

  const market = useMemo(
    () => (configured && readProvider ? new ethers.Contract(CONFIG.marketAddress, ENERGY_MARKET_ABI, readProvider) : null),
    [configured, readProvider]
  );
  const token = useMemo(
    () => (tokenAddress && readProvider ? new ethers.Contract(tokenAddress, ENERGY_TOKEN_ABI, readProvider) : null),
    [tokenAddress, readProvider]
  );

  // Lấy địa chỉ token từ market nếu .env không khai báo
  useEffect(() => {
    if (!market || tokenAddress) return;
    market.token().then(setTokenAddress).catch(e => setError(`Không đọc được token(): ${errorMessage(e)}`));
  }, [market, tokenAddress]);

  useEffect(() => {
    if (!token) return;
    Promise.all([token.symbol(), token.decimals(), token.name()])
      .then(([symbol, decimals, name]) => setTokenInfo({ symbol, decimals: Number(decimals), name }))
      .catch(e => setError(`Không đọc được thông tin token: ${errorMessage(e)}`));
  }, [token]);

  const refreshState = useCallback(async () => {
    if (!market) return;
    try {
      const slot = await market.currentSlot();
      setCurrentSlot(slot);
      const target = viewSlot ?? slot;
      const list = await market.getOrders(target);
      setOrders(list.map(o => ({
        id: o.id, trader: o.trader, isBid: o.isBid, qtyWh: o.qtyWh, pricePerWh: o.pricePerWh, filledWh: o.filledWh,
      })));
      if (account) {
        const [house, bal] = await Promise.all([
          market.houseOf(account).catch(() => ""),
          token ? token.balanceOf(account) : Promise.resolve(null),
        ]);
        setMyHouseId(house);
        setTokenBalance(bal);
      } else {
        setMyHouseId("");
        setTokenBalance(null);
      }
      setError("");
    } catch (e) {
      setError(`Lỗi đọc contract: ${errorMessage(e)}`);
    }
  }, [market, token, account, viewSlot]);

  // Quét log on-chain theo từng đoạn block
  const syncLogs = useCallback(async () => {
    if (!readProvider || !configured) return false;
    const head = await readProvider.getBlockNumber();
    setLatestBlock(head);
    let from = syncedTo.current === null ? CONFIG.deployBlock : syncedTo.current + 1;
    if (from > head) return false;
    const found = [];
    while (from <= head) {
      const to = Math.min(head, from + CONFIG.logChunk - 1);
      const logs = await readProvider.getLogs({ address: CONFIG.marketAddress, fromBlock: from, toBlock: to });
      for (const log of logs) {
        let parsed = null;
        try { parsed = marketIface.parseLog(log); } catch { parsed = null; }
        if (!parsed) continue;
        found.push({
          key: `${log.transactionHash}-${log.index ?? log.logIndex}`,
          name: parsed.name,
          args: plainArgs(parsed),
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.index ?? log.logIndex,
        });
      }
      syncedTo.current = to;
      from = to + 1;
    }
    if (found.length) {
      setEvents(prev => {
        const seen = new Set(prev.map(e => e.key));
        return [...prev, ...found.filter(e => !seen.has(e.key))].slice(-500);
      });
    }
    return true;
  }, [readProvider, configured]);

  // Vòng poll: log mới + state
  useEffect(() => {
    if (!market) return undefined;
    let stopped = false;
    let timer;
    const tick = async () => {
      try {
        await syncLogs();
        await refreshState();
      } catch (e) {
        setError(`Lỗi đồng bộ blockchain: ${errorMessage(e)}`);
      }
      if (!stopped) timer = setTimeout(tick, CONFIG.pollMs);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [market, syncLogs, refreshState]);

  // Khi đổi RPC/mạng thì quét lại từ đầu
  useEffect(() => {
    syncedTo.current = null;
    setEvents([]);
  }, [readProvider]);

  const houseByAddress = useMemo(() => {
    const map = {};
    events.filter(e => e.name === "HouseRegistered").forEach(e => { map[e.args.account.toLowerCase()] = e.args.houseId; });
    return map;
  }, [events]);

  const addressByHouse = useMemo(() => {
    const map = {};
    Object.entries(houseByAddress).forEach(([addr, h]) => { map[h] = addr; });
    return map;
  }, [houseByAddress]);

  async function runTx(label, fn) {
    setBusy(true);
    setError("");
    const entry = { id: Date.now() + Math.random(), label, hash: "", status: "waiting" };
    setTxs(prev => [entry, ...prev].slice(0, 10));
    const update = patch => setTxs(prev => prev.map(t => (t.id === entry.id ? { ...t, ...patch } : t)));
    try {
      const tx = await fn();
      update({ hash: tx.hash, status: "pending" });
      const receipt = await tx.wait();
      update({ status: receipt.status === 1 ? "success" : "failed", block: receipt.blockNumber });
      await syncLogs().catch(() => {});
      await refreshState();
      wallet.refreshBalance?.();
      return receipt;
    } catch (e) {
      update({ status: "failed", error: errorMessage(e) });
      setError(errorMessage(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }

  const register = useCallback(async houseId => {
    const signer = await getSigner();
    const m = new ethers.Contract(CONFIG.marketAddress, ENERGY_MARKET_ABI, signer);
    return runTx(`Đăng ký hộ ${houseId}`, () => m.register(houseId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getSigner, syncLogs, refreshState]);

  /** side: "ask" (bán) | "bid" (mua). Bid cần approve token để contract giữ escrow. */
  const placeOrder = useCallback(async ({ side, slot, qtyWh, priceKwh }) => {
    const signer = await getSigner();
    const me = await signer.getAddress();
    const m = new ethers.Contract(CONFIG.marketAddress, ENERGY_MARKET_ABI, signer);
    const qty = BigInt(qtyWh);
    const pricePerWh = pricePerKwhToPerWh(priceKwh, tokenInfo.decimals);
    if (qty <= 0n) throw new Error("Số lượng phải > 0");
    if (pricePerWh <= 0n) throw new Error("Giá quá nhỏ");
    const slotId = BigInt(slot);

    if (side === "bid") {
      if (!tokenAddress) throw new Error("Chưa xác định địa chỉ token");
      const t = new ethers.Contract(tokenAddress, ENERGY_TOKEN_ABI, signer);
      const cost = qty * pricePerWh;
      const allowance = await t.allowance(me, CONFIG.marketAddress);
      if (allowance < cost) {
        await runTx(`Approve ${ethers.formatUnits(cost, tokenInfo.decimals)} ${tokenInfo.symbol}`, () => t.approve(CONFIG.marketAddress, cost));
      }
      return runTx(`Đặt MUA ${qtyWh} Wh @ ${priceKwh}/kWh (slot ${slot})`, () => m.placeBid(slotId, qty, pricePerWh));
    }
    return runTx(`Đặt BÁN ${qtyWh} Wh @ ${priceKwh}/kWh (slot ${slot})`, () => m.placeAsk(slotId, qty, pricePerWh));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getSigner, tokenAddress, tokenInfo, syncLogs, refreshState]);

  return {
    configured,
    readable: !!readProvider,
    tokenAddress,
    tokenInfo,
    currentSlot,
    viewSlot,
    setViewSlot,
    orders,
    events,
    tokenBalance,
    myHouseId,
    latestBlock,
    houseByAddress,
    addressByHouse,
    error,
    txs,
    busy,
    register,
    placeOrder,
  };
}
