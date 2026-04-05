@echo off
:: Start the Claude Max plan proxy and SSH reverse tunnel to EC2.
:: Run this once — it stays open. Amy uses your Max plan tokens for free.
:: Close this window to disconnect (Amy falls back to OpenAI automatically).

title Amy Claude Proxy (Max Plan)

echo Starting Claude Max plan proxy on port 3456...
start /B node "%~dp0claude-proxy.js"

:: Wait for proxy to start
timeout /t 3 /nobreak >nul

:: Establish reverse tunnel to EC2
echo Connecting SSH tunnel to EC2 (98.80.164.16)...
echo Amy will use your Max plan tokens while this window is open.
echo Close this window to disconnect (falls back to OpenAI).
echo.

ssh -N -R 3456:localhost:3456 -i C:\Users\luked\.ssh\secondbrain-backend-key.pem -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 ec2-user@98.80.164.16
