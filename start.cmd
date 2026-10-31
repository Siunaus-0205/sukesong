@echo off
title ATLAS 需求规范化
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "data" mkdir "data"

echo.
echo   ATLAS 需求规范化
echo   地址: http://127.0.0.1:43125
echo   关闭本窗口即停止服务
echo.
start "" http://127.0.0.1:43125
node server.mjs
echo.
echo   服务已停止
echo.
pause
exit /b 0

:nonode
echo.
echo   [X] 没有检测到 Node.js
echo       请先安装 LTS 版本: https://nodejs.org/
echo       装完再双击本文件
echo.
pause
exit /b 1
