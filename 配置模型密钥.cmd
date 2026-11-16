@echo off
setlocal
echo Configure the DeepSeek API key for your Windows user.
echo Input is hidden. The key is not written to this project or printed.
powershell.exe -NoLogo -NoProfile -Command "$value=Read-Host 'DeepSeek API key' -AsSecureString; $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($value); try { $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer); if([string]::IsNullOrWhiteSpace($plain)){ throw 'No key entered' }; [Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY',$plain,'User'); Write-Host 'Saved to the current Windows user environment. Return to Thinkstar and recheck the model connection.' } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $plain=$null; $value.Dispose() }"
if errorlevel 1 echo Key configuration was not completed.
pause
