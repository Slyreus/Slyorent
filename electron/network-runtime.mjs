export const NETWORK_ENGINE_DIRECTORY = "transmission-4.1.4-openssl-3.5.9-curl-8.23.0";
export const NETWORK_BUILD_RUN = 42413650474;
export const NETWORK_BUILD_COMMIT = "42e9500867fb7a31f919d21d5f67a74fada5fd7c";
export const NETWORK_COMPONENTS = Object.freeze([
  {
    "name": "openssl",
    "version": "3.5.9",
    "archive": "OpenSSL-3.5.9-windows-x64.zip",
    "sha256": "e35441c53a00a6bc4afe64e96614e86b21897221d4794209c51f06f70189cd88",
    "files": {
      "libcrypto-3-x64.dll": "c8424e736cefd5d109e9ecb5161770ccbdd50ba1041b8fdc0cfee84dba37c3f5",
      "libssl-3-x64.dll": "630bac6af88817073307c79513ac94c85184a779700f0db8714358325dc061f7",
      "LICENSE.txt": "7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a",
      "BUILD.json": "3f7a40ead9763d7e32d6a06385e7d73941003cbb910def771876fcc7188d54c8"
    },
    "sourceUrl": "https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz",
    "sourceSha256": "603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a"
  },
  {
    "name": "curl",
    "version": "8.23.0",
    "archive": "Curl-8.23.0-windows-x64.zip",
    "sha256": "0aeea3e235f05c574d3c0938d74582d59d17476237efd6fac4a0527930134a74",
    "files": {
      "libcurl.dll": "46568f920fd6e11f467c402a844f5f5a34868058bf2194a5aafdd5c7cdc5d506",
      "LICENSE.txt": "82f2f4427d6545ee5aaac4f0b80428da6cc8ba41c2cf5da3a03680ec327b9681",
      "ZLIB-LICENSE.txt": "e32ff4e00d9d94930537635291da39e7e612703334bf6fde8c7f1686fe8a45a2",
      "BUILD.json": "16745a8800a8910b00fc5fd8c7340e288b1fa9b93306b5dbbbf045d61eec6178"
    },
    "sourceUrl": "https://github.com/curl/curl/releases/download/curl-8_23_0/curl-8.23.0.tar.xz",
    "sourceSha256": "8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5"
  }
]);
export const NETWORK_DLLS = Object.freeze(Object.fromEntries(NETWORK_COMPONENTS.flatMap(component => Object.entries(component.files).filter(([name]) => name.endsWith(".dll")))));
