[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $repository '.runtime'
$work = Join-Path $runtime 'curl-build'
$output = Join-Path $runtime 'curl-output'
foreach ($directory in @($work, $output)) {
    if (Test-Path -LiteralPath $directory) { throw 'Le dossier de compilation doit etre neuf.' }
    New-Item -ItemType Directory -Path $directory | Out-Null
}
function Get-Source([string]$uri, [string]$name, [string]$hash) {
    $archive = Join-Path $work $name
    Invoke-WebRequest -Uri $uri -OutFile $archive -UseBasicParsing
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Archive source non conforme.' }
    & tar -xf $archive -C $work
    if ($LASTEXITCODE -ne 0) { throw 'Extraction source impossible.' }
}
$curlUrl = 'https://github.com/curl/curl/releases/download/curl-8_23_0/curl-8.23.0.tar.xz'
$curlHash = '8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5'
$zlibUrl = 'https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz'
$zlibHash = 'bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16'
Get-Source $curlUrl 'curl.tar.xz' $curlHash
Get-Source $zlibUrl 'zlib.tar.gz' $zlibHash
$zlibSource = Join-Path $work 'zlib-1.3.2'
$zlibBuild = Join-Path $work 'zlib-build'
& cmake -S $zlibSource -B $zlibBuild -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded -DZLIB_BUILD_EXAMPLES=OFF
if ($LASTEXITCODE -ne 0) { throw 'Configuration zlib impossible.' }
& cmake --build $zlibBuild --target zlibstatic --parallel 4
if ($LASTEXITCODE -ne 0) { throw 'Compilation zlib impossible.' }
$openssl = Join-Path $runtime 'openssl-build\openssl-3.5.9'
$curlSource = Join-Path $work 'curl-8.23.0'
$curlBuild = Join-Path $work 'curl-build'
$configuration = @('-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', '-DBUILD_SHARED_LIBS=ON', '-DBUILD_STATIC_LIBS=OFF', '-DBUILD_CURL_EXE=OFF', '-DBUILD_TESTING=OFF', '-DCURL_USE_OPENSSL=ON', '-DCURL_USE_SCHANNEL=OFF', '-DCURL_ZLIB=ON', '-DCURL_BROTLI=OFF', '-DCURL_ZSTD=OFF', '-DUSE_NGHTTP2=OFF', '-DUSE_LIBIDN2=OFF', '-DCURL_USE_LIBPSL=OFF', '-DCURL_USE_LIBSSH2=OFF', '-DCURL_USE_LIBSSH=OFF', '-DCURL_CA_NATIVE=ON', '-DCURL_CA_BUNDLE=none', '-DCURL_CA_PATH=none')
foreach ($protocol in @('DICT','FILE','FTP','GOPHER','IMAP','LDAP','LDAPS','MQTT','POP3','RTSP','SCP','SFTP','SMB','SMTP','TELNET','TFTP')) { $configuration += "-DCURL_DISABLE_$protocol=ON" }
$configuration += "-DOPENSSL_INCLUDE_DIR=$openssl/include", "-DOPENSSL_SSL_LIBRARY=$openssl/libssl.lib", "-DOPENSSL_CRYPTO_LIBRARY=$openssl/libcrypto.lib", "-DZLIB_INCLUDE_DIR=$zlibSource;$zlibBuild", "-DZLIB_LIBRARY=$zlibBuild/zlibstatic.lib"
& cmake -S $curlSource -B $curlBuild @configuration
if ($LASTEXITCODE -ne 0) { throw 'Configuration curl impossible.' }
& cmake --build $curlBuild --parallel 4
if ($LASTEXITCODE -ne 0) { throw 'Compilation curl impossible.' }
$dll = Join-Path $curlBuild 'lib\libcurl.dll'
if (-not (Test-Path -LiteralPath $dll)) { throw 'DLL libcurl absente.' }
Copy-Item -LiteralPath $dll -Destination (Join-Path $output 'libcurl.dll')
Copy-Item -LiteralPath (Join-Path $curlSource 'COPYING') -Destination (Join-Path $output 'LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $zlibSource 'LICENSE') -Destination (Join-Path $output 'ZLIB-LICENSE.txt')
$manifest = [ordered]@{ version='8.23.0'; openssl='3.5.9'; zlib='1.3.2'; architecture='x64'; sourceUrl=$curlUrl; sourceSha256=$curlHash; zlibSourceUrl=$zlibUrl; zlibSourceSha256=$zlibHash; configuration=$configuration; workflowCommit=$env:GITHUB_SHA; runId=$env:GITHUB_RUN_ID; files=@() }
foreach ($file in Get-ChildItem -LiteralPath $output -File) { $manifest.files += @{ name=$file.Name; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } }
[IO.File]::WriteAllText((Join-Path $output 'BUILD.json'), ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
Compress-Archive -LiteralPath @((Join-Path $output 'libcurl.dll'), (Join-Path $output 'LICENSE.txt'), (Join-Path $output 'ZLIB-LICENSE.txt'), (Join-Path $output 'BUILD.json')) -DestinationPath (Join-Path $runtime 'artifacts\Curl-8.23.0-windows-x64.zip')
Get-FileHash -LiteralPath (Join-Path $runtime 'artifacts\Curl-8.23.0-windows-x64.zip') -Algorithm SHA256 | Select-Object Hash
