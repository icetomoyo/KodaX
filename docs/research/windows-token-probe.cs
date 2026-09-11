// Isolated diagnostic only. Does not provision accounts or modify existing user ACLs.
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class TokenProbe {
    [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct TokenDefaultDacl { public IntPtr Dacl; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public int Size; public string Reserved; public string Desktop; public string Title;
        public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags; public ushort Show,Reserved2;
        public IntPtr ReservedPtr,Input,Output,Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint ProcessId,ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct JobLimits {
        public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinWorkingSet,MaxWorkingSet;
        public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority,Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedJobLimits {
        public JobLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
    }
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr buffer, uint length, out uint needed);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSidToSid(string text,out IntPtr sid);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr sd,uint revision,uint info,out IntPtr text,out uint length);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr sd,out uint size);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr sd,out bool present,out IntPtr dacl,out bool defaulted);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int cls,ref TokenDefaultDacl value,uint length);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint disabled,IntPtr disabledSids,uint privileges,IntPtr deletePrivileges,uint count,[In] SidAndAttributes[] sids,out IntPtr restricted);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr token,string app,StringBuilder command,IntPtr processAttrs,IntPtr threadAttrs,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupInfo startup,out ProcessInfo process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr devmode,uint flags,uint access,ref SecurityAttributes security);
    [DllImport("user32.dll", SetLastError=true)] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref ExtendedJobLimits limits,uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);

    static void Check(bool ok,string action) { if(!ok) { int code=Marshal.GetLastWin32Error(); throw new Win32Exception(code,action+" error="+code); } }
    static IntPtr Info(IntPtr token,int cls) {
        uint size; GetTokenInformation(token,cls,IntPtr.Zero,0,out size);
        var p=Marshal.AllocHGlobal((int)size);
        try { Check(GetTokenInformation(token,cls,p,size,out size),"GetTokenInformation"); return p; }
        catch { Marshal.FreeHGlobal(p); throw; }
    }
    static List<string> Groups(IntPtr token,int cls,bool logonOnly) {
        var p=Info(token,cls); var answer=new List<string>();
        try {
            int count=Marshal.ReadInt32(p); int offset=IntPtr.Size==8?8:4;
            for(int i=0;i<count;i++) {
                var value=(SidAndAttributes)Marshal.PtrToStructure(IntPtr.Add(p,offset+i*Marshal.SizeOf(typeof(SidAndAttributes))),typeof(SidAndAttributes));
                if(!logonOnly || (value.Attributes & 0xc0000000)==0xc0000000) answer.Add(new SecurityIdentifier(value.Sid).Value);
            }
        } finally { Marshal.FreeHGlobal(p); }
        return answer;
    }
    static void DefaultDacl(IntPtr token,string logon,string cap) {
        IntPtr sd; uint size;
        Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;"+logon+")(A;;GA;;;WD)(A;;GA;;;"+cap+")",1,out sd,out size),"DefaultDacl SDDL");
        try {
            bool present,defaulted; IntPtr dacl;
            Check(GetSecurityDescriptorDacl(sd,out present,out dacl,out defaulted),"GetSecurityDescriptorDacl");
            var info=new TokenDefaultDacl { Dacl=dacl };
            Check(SetTokenInformation(token,6,ref info,(uint)Marshal.SizeOf(typeof(TokenDefaultDacl))),"SetTokenInformation DefaultDacl");
        } finally { LocalFree(sd); }
    }
    static uint Launch(IntPtr token,string app,string args,string cwd,string desktop) {
        var startup=new StartupInfo { Size=Marshal.SizeOf(typeof(StartupInfo)),Desktop=desktop };
        ProcessInfo process=new ProcessInfo();
        var job=CreateJobObject(IntPtr.Zero,null);
        Check(job!=IntPtr.Zero,"CreateJobObject");
        try {
            var limits=new ExtendedJobLimits { Basic=new JobLimits { Flags=0x2000 } }; // KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedJobLimits))),"SetInformationJobObject");
            Check(CreateProcessAsUser(token,app,new StringBuilder("\""+app+"\" "+args),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,cwd,ref startup,out process),"CreateProcessAsUser");
            Check(AssignProcessToJobObject(job,process.Process),"AssignProcessToJobObject");
            Check(ResumeThread(process.Thread)!=0xffffffff,"ResumeThread");
            var wait=WaitForSingleObject(process.Process,15000);
            if(wait==0x102) return 0xdead;
            Check(wait==0,"WaitForSingleObject");
            uint code; Check(GetExitCodeProcess(process.Process,out code),"GetExitCodeProcess"); return code;
        } finally {
            // Also cleans descendant pipes/processes after a timeout. A target
            // that could not join the job is still suspended and is killed here.
            try {
                if(process.Process!=IntPtr.Zero && WaitForSingleObject(process.Process,0)!=0) {
                    Check(TerminateProcess(process.Process,0xdead),"TerminateProcess");
                }
            } finally {
                CloseHandle(job);
                if(process.Process!=IntPtr.Zero) { WaitForSingleObject(process.Process,5000); CloseHandle(process.Process); }
                if(process.Thread!=IntPtr.Zero) CloseHandle(process.Thread);
            }
        }
    }
    static IntPtr PrivateDesktop(string desktopName,string account,string cap) {
        IntPtr sd; uint size;
        Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;"+account+")(A;;GA;;;"+cap+")",1,out sd,out size),"Desktop SDDL");
        try {
            var sa=new SecurityAttributes { Length=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=sd };
            var desktop=CreateDesktop(desktopName,IntPtr.Zero,IntPtr.Zero,0,0x000f01ff,ref sa);
            Check(desktop!=IntPtr.Zero,"CreateDesktop");
            return desktop;
        } finally { LocalFree(sd); }
    }
    static Dictionary<string,string[]> ProbeCases(string outside,string node) {
        return new Dictionary<string,string[]> {
            {"cmd",new[]{Environment.GetEnvironmentVariable("ComSpec"),"/d /c exit 37"}},
            {"powershell_pipeline",new[]{Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell\\v1.0\\powershell.exe"),"-NoLogo -NoProfile -NonInteractive -Command \"$v = 1,2 | ForEach-Object { $_ * 2 }; if (($v -join ',') -eq '2,4') { exit 37 } else { exit 38 }\""}},
            {"node",new[]{node,"-e \"process.exit(37)\""}},
            {"external_write",new[]{node,"-e \"try { require('fs').appendFileSync(process.argv[1], 'changed'); process.exit(42); } catch(e) { process.exit(e.code === 'EACCES' || e.code === 'EPERM' ? 41 : 43); }\" \""+outside+"\""}},
            {"node_child_ipc",new[]{node,"-e \"const c=require('child_process').spawn(process.execPath,['-e','process.exit(37)']); c.on('error',()=>process.exit(39)); c.on('exit',code=>process.exit(code));\""}}
        };
    }
    public static void Run(string root,string outside,string node) {
        SetErrorMode(0x0001|0x0002|0x8000);
        IntPtr token; Check(OpenProcessToken(GetCurrentProcess(),0xf01ff,out token),"OpenProcessToken");
        var allocations=new List<IntPtr>(); IntPtr desktop=IntPtr.Zero;
        try {
            var account=WindowsIdentity.GetCurrent().User.Value;
            var logons=Groups(token,2,true);
            var baseRestrictions=Groups(token,11,false);
            Console.WriteLine("BASE account="+account+" restrictions="+String.Join(",",baseRestrictions.ToArray()));
            if(baseRestrictions.Count!=0) throw new Exception("Run from an unrestricted host token: an already restricted token cannot provide an independent variant comparison.");
            if(logons.Count!=1) throw new Exception("Expected one logon SID");
            string logon=logons[0],cap="S-1-5-21-111111111-222222222-333333333-444444444";
            string desktopName="KodaXTokenProbe-"+Guid.NewGuid().ToString("N");
            desktop=PrivateDesktop(desktopName,account,cap);
            var variants=new Dictionary<string,string[]> {
                {"current",new[]{cap,account,logon,"S-1-1-0"}},
                {"cap_only",new[]{cap}},
                {"cap_logon",new[]{cap,logon}},
                {"cap_everyone",new[]{cap,"S-1-1-0"}},
                {"cap_account",new[]{cap,account}}
            };
            foreach(var variant in variants) {
                var entries=new List<SidAndAttributes>();
                foreach(string sidText in variant.Value) {
                    IntPtr sid;Check(ConvertStringSidToSid(sidText,out sid),"ConvertStringSidToSid"); allocations.Add(sid);
                    entries.Add(new SidAndAttributes { Sid=sid });
                }
                IntPtr restricted;
                Check(CreateRestrictedToken(token,0x1|0x4|0x8,0,IntPtr.Zero,0,IntPtr.Zero,(uint)entries.Count,entries.ToArray(),out restricted),"CreateRestrictedToken");
                try {
                    DefaultDacl(restricted,logon,cap);
                    Console.WriteLine("TOKEN "+variant.Key+" restrictions="+String.Join(",",Groups(restricted,11,false).ToArray()));
                    var cases=ProbeCases(outside,node);
                    foreach(var test in cases) {
                        try { var code=Launch(restricted,test.Value[0],test.Value[1],root,"WinSta0\\"+desktopName); Console.WriteLine(variant.Key+" "+test.Key+" exit="+code+" hex=0x"+code.ToString("x8")); }
                        catch(Exception e) { Console.WriteLine(variant.Key+" "+test.Key+" ERROR="+e.Message); }
                    }
                } finally { CloseHandle(restricted); }
            }
        } finally {
            if(desktop!=IntPtr.Zero) CloseDesktop(desktop);
            foreach(var p in allocations) LocalFree(p);
            CloseHandle(token);
        }
    }
}
