import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { CONFIG } from "../config";
import { errorMessage } from "../lib/format";

const hasMetaMask = () => typeof window !== "undefined" && !!window.ethereum;
const DISCONNECT_KEY = "p2p-wallet-disconnected";
const markDisconnected = on => {
  try {
    if (on) localStorage.setItem(DISCONNECT_KEY, "1");
    else localStorage.removeItem(DISCONNECT_KEY);
  } catch {
    /* bỏ qua nếu trình duyệt chặn localStorage */
  }
};
const isMarkedDisconnected = () => {
  try {
    return localStorage.getItem(DISCONNECT_KEY) === "1";
  } catch {
    return false;
  }
};

/** Quản lý kết nối MetaMask: tài khoản, mạng, số dư ETH, chuyển mạng. */
export function useWallet() {
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState(null);
  const [ethBalance, setEthBalance] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  const wrongNetwork = !!account && chainId !== null && chainId !== CONFIG.chainId;

  const refresh = useCallback(async addr => {
    if (!hasMetaMask()) return;
    const provider = new ethers.BrowserProvider(window.ethereum);
    const net = await provider.getNetwork();
    setChainId(Number(net.chainId));
    if (addr) setEthBalance(await provider.getBalance(addr));
  }, []);

  // Tự nhận lại ví nếu người dùng đã cấp quyền trước đó (không bật popup).
  useEffect(() => {
    if (!hasMetaMask()) return undefined;
    const eth = window.ethereum;
    eth.request({ method: "eth_accounts" }).then(accs => {
      // người dùng đã bấm "Ngắt kết nối" thì không tự kết nối lại khi tải trang
      const a = accs?.[0] && !isMarkedDisconnected() ? ethers.getAddress(accs[0]) : "";
      setAccount(a);
      refresh(a).catch(() => {});
    });
    const onAccounts = accs => {
      if (isMarkedDisconnected()) return;
      const a = accs?.[0] ? ethers.getAddress(accs[0]) : "";
      setAccount(a);
      setEthBalance(null);
      refresh(a).catch(() => {});
    };
    const onChain = hex => {
      setChainId(Number(hex));
      eth.request({ method: "eth_accounts" }).then(accs => refresh(accs?.[0] ? ethers.getAddress(accs[0]) : "")).catch(() => {});
    };
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    if (!hasMetaMask()) {
      setError("Chưa cài MetaMask");
      window.open("https://metamask.io/download/", "_blank");
      return;
    }
    try {
      setConnecting(true);
      setError("");
      const accs = await window.ethereum.request({ method: "eth_requestAccounts" });
      markDisconnected(false);
      const a = ethers.getAddress(accs[0]);
      setAccount(a);
      await refresh(a);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setConnecting(false);
    }
  }, [refresh]);

  /** Mở hộp chọn tài khoản của MetaMask để đổi sang ví khác (ví dụ H05 -> H06). */
  const switchAccount = useCallback(async () => {
    if (!hasMetaMask()) return;
    try {
      setError("");
      await window.ethereum.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      markDisconnected(false);
      const accs = await window.ethereum.request({ method: "eth_accounts" });
      const a = accs?.[0] ? ethers.getAddress(accs[0]) : "";
      setAccount(a);
      setEthBalance(null);
      await refresh(a);
    } catch (e) {
      if (e?.code !== 4001) setError(errorMessage(e)); // 4001 = người dùng bấm Cancel
    }
  }, [refresh]);

  /** Ngắt kết nối ví khỏi dashboard (thu hồi quyền của trang trong MetaMask nếu được). */
  const disconnect = useCallback(async () => {
    markDisconnected(true);
    setAccount("");
    setEthBalance(null);
    setError("");
    try {
      await window.ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {
      /* ví cũ không hỗ trợ thu hồi quyền: chỉ ngắt ở phía dashboard */
    }
  }, []);

  const switchNetwork = useCallback(async () => {
    if (!hasMetaMask()) return;
    const hexId = ethers.toBeHex(CONFIG.chainId);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (e) {
      // 4902: MetaMask chưa có mạng này (vd. Hardhat local) -> thêm mới
      if ((e?.code === 4902 || e?.data?.originalError?.code === 4902) && CONFIG.rpcUrl) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: hexId,
              chainName: CONFIG.chainName,
              rpcUrls: [CONFIG.rpcUrl],
              nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
              blockExplorerUrls: CONFIG.etherscanBase ? [CONFIG.etherscanBase] : undefined,
            }],
          });
        } catch (e2) {
          setError(errorMessage(e2));
        }
      } else {
        setError(errorMessage(e));
      }
    }
  }, []);

  const getSigner = useCallback(async () => {
    if (!hasMetaMask()) throw new Error("Chưa cài MetaMask");
    if (wrongNetwork) throw new Error(`Sai mạng — hãy chuyển MetaMask sang ${CONFIG.chainName}`);
    const provider = new ethers.BrowserProvider(window.ethereum);
    return provider.getSigner();
  }, [wrongNetwork]);

  return {
    hasMetaMask: hasMetaMask(),
    account,
    chainId,
    ethBalance,
    wrongNetwork,
    connecting,
    error,
    connect,
    switchAccount,
    disconnect,
    switchNetwork,
    getSigner,
    refreshBalance: () => refresh(account),
  };
}
