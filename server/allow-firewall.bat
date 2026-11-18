@echo off
rem Allow other PCs on the lab network to reach FoCT Virtual Labs (ports 8080 and 8443).
rem Right-click this file and choose "Run as administrator".
net session >nul 2>&1
if errorlevel 1 (
  echo Please right-click allow-firewall.bat and choose "Run as administrator".
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="FoCT Virtual Labs" >nul 2>&1
netsh advfirewall firewall add rule name="FoCT Virtual Labs" dir=in action=allow protocol=TCP localport=8080,8443 profile=domain,private
if errorlevel 1 (
  echo Could not add the firewall rule.
) else (
  echo Firewall rule "FoCT Virtual Labs" added for TCP ports 8080 and 8443 on domain and private networks.
  echo If the lab network is marked "Public" in Windows, change it to "Private" in Settings ^> Network.
)
pause
