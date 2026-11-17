export const NETWORK_RELEASE_TAG = "v1.1.12";
export const NETWORK_ENGINE_DIRECTORY = `transmission-4.1.4-network-${NETWORK_RELEASE_TAG}`;
export const NETWORK_BUILD_RUN = 44154767706;
export const NETWORK_BUILD_COMMIT = "1554566c22c899266c8dc429deeb88a63b443583";
export const NETWORK_COMPONENTS = Object.freeze([
  {
    "name": "openssl",
    "version": "3.5.9",
    "archive": "OpenSSL-3.5.9-windows-x64.zip",
    "sha256": "0e952e1dfcff0590b1487469b5f972448aca50949b1c43e545bfd718bc3b6a74",
    "files": {
      "libcrypto-3-x64.dll": "78683a54ee36a77e1d173f8eff46ca030ec0d5e31ccba428722bf0b9c9a7c2f0",
      "libssl-3-x64.dll": "8d7a621cf596ab7b8107b7766bd7853ce66a68f06f01def401be092a738a1f32",
      "LICENSE.txt": "7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a",
      "BUILD.json": "164dca279f6b250cdb654ffc1646471175ffe6a02f49f13f75e87219bca023e3"
    },
    "sourceUrl": "https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz",
    "sourceSha256": "603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a"
  },
  {
    "name": "curl",
    "version": "8.23.0",
    "archive": "Curl-8.23.0-zlib-1.4-windows-x64.zip",
    "sha256": "66355bb917d3e3aeb56045dc1ecfe812056c9e2f5cba37024e0fc918f35251a4",
    "files": {
      "libcurl.dll": "51e601db3263c88bf77a29a8a8f99fa550f1ea78f90c451389e4e32c24cdf74e",
      "LICENSE.txt": "82f2f4427d6545ee5aaac4f0b80428da6cc8ba41c2cf5da3a03680ec327b9681",
      "ZLIB-LICENSE.txt": "e32ff4e00d9d94930537635291da39e7e612703334bf6fde8c7f1686fe8a45a2",
      "BUILD.json": "87bbe36acc033cb35d9d64181933139065723463a0eb8c369deecdb5d261d486"
    },
    "sourceUrl": "https://github.com/curl/curl/releases/download/curl-8_23_0/curl-8.23.0.tar.xz",
    "sourceSha256": "8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5",
    "zlib": "1.4",
    "zlibSourceSha256": "02dd159783677a749c04adbdd02b55b8a2bcc7e054f51b76b549199a916ad584"
  }
]);
export const NETWORK_DLLS = Object.freeze(Object.fromEntries(NETWORK_COMPONENTS.flatMap(component => Object.entries(component.files).filter(([name]) => name.endsWith(".dll")))));
