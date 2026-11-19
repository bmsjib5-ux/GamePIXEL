@echo off
rem Starts a small local web server for the game and opens it in the default browser.
rem Close this window to stop the server.
cd /d "%~dp0"
start "" http://127.0.0.1:8780/
python -m http.server 8780 --bind 127.0.0.1
