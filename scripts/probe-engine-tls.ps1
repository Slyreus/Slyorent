[CmdletBinding()]
param([Parameter(Mandatory)][string]$EngineDirectory, [Parameter(Mandatory)][string]$Url, [Parameter(Mandatory)][string]$CaFile)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $env:PSModulePath = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\Modules'
    Import-Module (Join-Path $env:PSModulePath 'Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force
}
$uri = [Uri]$Url
if ($uri.Scheme -ne 'https' -or $uri.Host -ne '127.0.0.1') { throw 'Ce controle accepte uniquement HTTPS sur la boucle locale.' }
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SlyorrentTlsProbe {
  [StructLayout(LayoutKind.Sequential)] struct Blob { public IntPtr data; public UIntPtr length; public uint flags; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr LoadLibraryExW(string name, IntPtr reserved, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Ansi, ExactSpelling=true)]
  static extern IntPtr GetProcAddress(IntPtr module, string name);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr PointerCall();
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr VersionCall(int type);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int InitCall(int flags);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int OptionCall(IntPtr handle, int option, IntPtr value);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int PerformCall(IntPtr handle);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int InfoCall(IntPtr handle, int info, out int value);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void CleanupCall(IntPtr handle);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void GlobalCleanupCall();
  static T Function<T>(IntPtr module, string name) where T: class {
    var address=GetProcAddress(module,name);
    if(address==IntPtr.Zero) throw new MissingMethodException(name);
    return (T)(object)Marshal.GetDelegateForFunctionPointer(address,typeof(T));
  }
  static IntPtr Load(string path) {
    var module=LoadLibraryExW(Path.GetFullPath(path),IntPtr.Zero,0x1100);
    if(module==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    return module;
  }
  public static object Run(string directory, string url, string caFile) {
    var crypto=Load(Path.Combine(directory,"libcrypto-3-x64.dll"));
    Load(Path.Combine(directory,"libssl-3-x64.dll"));
    var curl=Load(Path.Combine(directory,"libcurl.dll"));
    var version=Marshal.PtrToStringAnsi(Function<VersionCall>(crypto,"OpenSSL_version")(0));
    var curlVersion=Marshal.PtrToStringAnsi(Function<PointerCall>(curl,"curl_version")());
    if(Function<InitCall>(curl,"curl_global_init")(3)!=0) throw new Exception("Initialisation curl impossible");
    var handle=Function<PointerCall>(curl,"curl_easy_init")();
    if(handle==IntPtr.Zero) throw new Exception("Session curl impossible");
    var urlPtr=Marshal.StringToHGlobalAnsi(url);
    var caBytes=File.ReadAllBytes(caFile);
    var caPtr=Marshal.AllocHGlobal(caBytes.Length);
    Marshal.Copy(caBytes,0,caPtr,caBytes.Length);
    var blobPtr=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Blob)));
    Marshal.StructureToPtr(new Blob{data=caPtr,length=new UIntPtr((uint)caBytes.Length),flags=1},blobPtr,false);
    var errorPtr=Marshal.AllocHGlobal(256);
    Marshal.Copy(new byte[256],0,errorPtr,256);
    var noProxy=Marshal.StringToHGlobalAnsi("");
    try {
      var option=Function<OptionCall>(curl,"curl_easy_setopt");
      var keys=new[]{10002,40309,10004,64,81,44,13,10010};
      var values=new[]{urlPtr,blobPtr,noProxy,new IntPtr(1),new IntPtr(2),new IntPtr(1),new IntPtr(10),errorPtr};
      for(int index=0;index<keys.Length;index++) {
        if(option(handle,keys[index],values[index])!=0) throw new Exception("Option TLS refusee");
      }
      var code=Function<PerformCall>(curl,"curl_easy_perform")(handle);
      int status;
      Function<InfoCall>(curl,"curl_easy_getinfo")(handle,0x200002,out status);
      return new { code, status, openssl=version, curl=curlVersion, error=Marshal.PtrToStringAnsi(errorPtr) };
    } finally {
      Function<CleanupCall>(curl,"curl_easy_cleanup")(handle);
      Function<GlobalCleanupCall>(curl,"curl_global_cleanup")();
      Marshal.FreeHGlobal(urlPtr); Marshal.FreeHGlobal(caPtr); Marshal.FreeHGlobal(blobPtr); Marshal.FreeHGlobal(errorPtr); Marshal.FreeHGlobal(noProxy);
    }
  }
}
'@
[SlyorrentTlsProbe]::Run($EngineDirectory, $Url, $CaFile) | ConvertTo-Json -Compress
