@echo off
color 0A
title P2P Energy Auto-Starter

echo [1/6] Khoi dong Blockchain Node...
start "1. Node" cmd /k "cd contracts && npm run node"
:: Doi 4 giay cho Node chay len
timeout /t 4 /nobreak >nul

echo [2/6] Khoi dong MQTT Broker...
start "2. Broker" cmd /k "cd contracts && npm run broker"

echo [3/6] Tu dong Deploy va Cap von (Seed)...
cd contracts
call npm run deploy:local
call npm run seed:local
cd ..
timeout /t 2 /nobreak >nul

echo [4/6] Khoi dong Bridge va AI...
start "3. Bridge" cmd /k "cd contracts && npm run bridge:local"
start "4. AI" cmd /k "cd ai_model && python src/service_lstm.py"

echo [5/6] Khoi dong Web Dashboard...
start "5. Web" cmd /k "cd dashboard && npm run dev"

echo [6/6] Goi Raspberry Pi chay IoT...
start "6. IoT Pi" cmd /k "ssh rinaka@192.168.137.122 'cd /home/rinaka/P2P_Edge_Node && source p2p_env/bin/activate && python edge_node.py'"

echo HOAN TAT! 
pause