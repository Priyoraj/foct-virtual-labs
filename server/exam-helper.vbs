' FoCT Virtual Labs - exam helper for Windows 10 and 11
'
' Run it (double-click) when your teacher starts an exam that needs it. While the exam runs it:
'   - closes other programs (editors, other browsers, chat, remote-desktop, screenshot and
'     terminal tools) and keeps them closed;
'   - opens the exam in Microsoft Edge, full screen, with no address bar, no tabs and no
'     internet (only the lab server can be reached);
'   - turns off Task Manager and the clipboard history (if the teacher chose that);
'   - with administrator rights, when this PC allows them: turns off the developer tools in Edge
'     and Chrome and blocks USB drives;
'   - tells the lab server every few seconds what it sees (USB drives, a second screen, programs
'     it had to close). The lab server lets this PC take part in the exam only while it runs.
' It needs no administrator rights, and everything it changes it puts back: when the teacher ends
' the exam, or at the next sign-in if the PC restarts first. To put the PC back by hand, run it
' with /restore.
'
'   exam-helper.vbs            start (asks first)
'   exam-helper.vbs /restore   put this PC back to normal
'   exam-helper.vbs /test      try it out: talks to the server but changes nothing on this PC
'
' The lab server fills in its address below when the file is downloaded from it.
Option Explicit

Const SERVER = "__FOCT_SERVER__"
Const VERSION = "1"
Const APPNAME = "FoCT exam helper"
Const BEAT_MS = 3000
Const SYSTEM_MODAL = 4096

Dim sh, fso, wmi, testMode, restoreMode, machineMode, elevatedArg, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")
For i = 0 To WScript.Arguments.Count - 1
  Select Case LCase(WScript.Arguments(i))
    Case "/test": testMode = True
    Case "/restore": restoreMode = True
    Case "/restore-machine": machineMode = True
    Case "/elevated": elevatedArg = True
  End Select
Next

Dim HOME, MHOME, BACKUP, MBACKUP, LOGFILE, PROFILE, RUNONCE, TASKNAME
If testMode Then
  HOME = sh.ExpandEnvironmentStrings("%TEMP%") & "\FoCTExamTest"
  MHOME = HOME & "\machine"
Else
  HOME = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\FoCTExam"
  MHOME = sh.ExpandEnvironmentStrings("%ProgramData%") & "\FoCTExam"
End If
BACKUP = HOME & "\backup.txt"
MBACKUP = MHOME & "\backup-machine.txt"
LOGFILE = HOME & "\helper.log"
PROFILE = HOME & "\edge"
RUNONCE = "HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce\!FoCTExamRestore"
TASKNAME = "FoCT exam restore"

Const TASKMGR_KEY = "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System\DisableTaskMgr"
Const CLIPHIST_KEY = "HKCU\Software\Microsoft\Clipboard\EnableClipboardHistory"
Const EDGE_DEVTOOLS = "HKLM\SOFTWARE\Policies\Microsoft\Edge\DeveloperToolsAvailability"
Const CHROME_DEVTOOLS = "HKLM\SOFTWARE\Policies\Google\Chrome\DeveloperToolsAvailability"
Const USB_DENY = "HKLM\SOFTWARE\Policies\Microsoft\Windows\RemovableStorageDevices\Deny_All"
' Never closed, whatever the list says: Windows itself, the exam browser and this script.
Const NEVER = ",explorer.exe,dwm.exe,csrss.exe,winlogon.exe,lsass.exe,services.exe,svchost.exe,smss.exe,wininit.exe,ctfmon.exe,sihost.exe,fontdrvhost.exe,taskhostw.exe,runtimebroker.exe,searchhost.exe,startmenuexperiencehost.exe,shellexperiencehost.exe,textinputhost.exe,wscript.exe,cscript.exe,rundll32.exe,conhost.exe,msedge.exe,msedgewebview2.exe,"

Dim token, kiosk, title, killList, optTaskmgr, optAdmin, myPid, elevated, edgeExe
Dim tmOff, devOff, usbBlocked, problem, killedNow, relaunched, screens, lastScreens, ready, beats

EnsureDir HOME
Log "---- start " & Join(ArgList(), " ") & " (version " & VERSION & ")"

If machineMode Then
  RestoreMachine
  WScript.Quit 0
End If
If restoreMode Then
  RestoreAll True
  WScript.Quit 0
End If

Main
WScript.Quit 0

' ============================================================================ main
Sub Main()
  Dim resp
  myPid = OwnPid()
  If elevatedArg Then
    WriteText HOME & "\elevated.started", "1"              ' tells the first copy that this one carries on
  ElseIf OtherHelperRunning() Then
    Say "The exam helper is already running on this PC.", vbInformation
    Exit Sub
  End If
  If fso.FileExists(BACKUP) Then RestoreAll True          ' a previous run did not finish: put things back first
  If LCase(Left(sh.ExpandEnvironmentStrings("%SESSIONNAME%"), 4)) = "rdp-" Then
    Say "The exam cannot be taken over a remote desktop connection.", vbExclamation
    Exit Sub
  End If
  edgeExe = EdgePath()
  If edgeExe = "" Then
    Say "Microsoft Edge was not found on this PC. Ask your teacher.", vbExclamation
    Exit Sub
  End If

  resp = Hello()
  If resp = "" Then
    Say "The lab server (" & SERVER & ") cannot be reached. Check the network and try again.", vbExclamation
    Exit Sub
  End If
  If Not JBool(resp, "ok") Then
    Say JStr(resp, "error"), vbInformation
    Exit Sub
  End If
  ReadSettings resp

  If Not testMode And Not elevatedArg Then
    Dim msg
    msg = "Exam: " & title & vbCrLf & vbCrLf & _
          "The exam helper will now:" & vbCrLf & _
          "  - close other programs (save your work in them first)," & vbCrLf & _
          "  - open the exam in a full-screen browser without internet" & vbCrLf
    If optTaskmgr Then msg = msg & "  - turn off Task Manager and the clipboard history" & vbCrLf
    msg = msg & vbCrLf & "Your PC goes back to normal when the exam ends, or when it restarts." & vbCrLf & vbCrLf & "Start the exam?"
    If MsgBox(msg, vbOKCancel + vbQuestion + SYSTEM_MODAL, APPNAME) <> vbOK Then
      Bye "cancelled by the student"
      Exit Sub
    End If
  End If

  elevated = IsElevated()
  If testMode Then elevated = optAdmin                    ' try the administrator part too (on test keys)
  If optAdmin And Not elevated And Not elevatedArg And Not testMode And IsAdminAccount() Then
    If AskElevation() Then Exit Sub                       ' the elevated copy carries on
  End If

  Lockdown
  RunExam
  RestoreAll False
End Sub

Sub ReadSettings(resp)
  token = JStr(resp, "token")
  If JStr(resp, "kiosk") <> "" Then kiosk = JStr(resp, "kiosk")
  title = JStr(resp, "title")
  killList = "," & Replace(LCase(JStr(resp, "kill")), " ", "") & ","
  optTaskmgr = JBool(resp, "taskmgr")
  optAdmin = JBool(resp, "admin")
  If testMode Then WriteText HOME & "\token.txt", token
End Sub

Function Hello()
  Hello = Http("POST", SERVER & "/__exam/agent/hello", "{""pc"":""" & JEsc(sh.ExpandEnvironmentStrings("%COMPUTERNAME%")) & _
          """,""user"":""" & JEsc(sh.ExpandEnvironmentStrings("%USERNAME%")) & """,""version"":""" & VERSION & """}")
End Function

' ============================================================================ lock down / run / put back
Sub Lockdown()
  ' a copy that stays put, for the restore after a restart
  If LCase(WScript.ScriptFullName) <> LCase(HOME & "\exam-helper.vbs") Then fso.CopyFile WScript.ScriptFullName, HOME & "\exam-helper.vbs", True
  BackupValue BACKUP, RUNONCE                             ' (normally absent)
  RegSet RUNONCE, "wscript.exe //B """ & HOME & "\exam-helper.vbs"" /restore", "REG_SZ"
  If optTaskmgr Then
    BackupValue BACKUP, TASKMGR_KEY
    BackupValue BACKUP, CLIPHIST_KEY
    tmOff = RegSet(TASKMGR_KEY, 1, "REG_DWORD")
    RegSet CLIPHIST_KEY, 0, "REG_DWORD"
    If Not tmOff Then problem = "Task Manager could not be turned off"
  End If
  If elevated And optAdmin Then
    EnsureDir MHOME
    If LCase(WScript.ScriptFullName) <> LCase(MHOME & "\exam-helper.vbs") Then fso.CopyFile WScript.ScriptFullName, MHOME & "\exam-helper.vbs", True
    BackupValue MBACKUP, EDGE_DEVTOOLS
    BackupValue MBACKUP, CHROME_DEVTOOLS
    BackupValue MBACKUP, USB_DENY
    devOff = RegSet(EDGE_DEVTOOLS, 2, "REG_DWORD")
    RegSet CHROME_DEVTOOLS, 2, "REG_DWORD"
    usbBlocked = RegSet(USB_DENY, 1, "REG_DWORD")
    ' if the PC restarts during the exam, Windows puts these back at start-up
    RunHidden "schtasks /Create /F /RU SYSTEM /SC ONSTART /TN """ & TASKNAME & """ /TR ""wscript.exe //B \""" & MHOME & "\exam-helper.vbs\"" /restore-machine""", True
  End If
  RunHidden "cmd /c echo off| clip", True                 ' empty the clipboard
  KillSweep True                                          ' every other browser too, before the exam browser starts
  CleanProfile
  StartBrowser
  ready = True
  Log "locked down: taskmgr=" & tmOff & " admin=" & elevated & " devtools=" & devOff & " usbblock=" & usbBlocked
End Sub

Sub RunExam()
  Dim resp, lastContact
  lastContact = Now
  screens = ScreenCount()
  Do
    killedNow = ""
    KillSweep False
    If Not BrowserRunning() Then
      relaunched = relaunched + 1
      Log "exam browser was closed: opening it again"
      StartBrowser
    End If
    beats = beats + 1
    If beats Mod 10 = 0 Then screens = ScreenCount()
    resp = Http("POST", SERVER & "/__exam/agent/beat", BeatJson())
    If resp <> "" Then
      lastContact = Now
      If Not JBool(resp, "known") Then                    ' the server forgot this PC (restarted): introduce it again
        Dim r2
        r2 = Hello()
        If JBool(r2, "ok") Then ReadSettings r2
      Else
        killList = "," & Replace(LCase(JStr(resp, "kill")), " ", "") & ","
      End If
      If JBool(resp, "end") Then
        Log "the exam has ended"
        Exit Do
      End If
    ElseIf DateDiff("n", lastContact, Now) >= 30 Then
      Log "no contact with the lab server for 30 minutes: putting the PC back"
      Exit Do
    End If
    WScript.Sleep BEAT_MS
  Loop
End Sub

Sub RestoreAll(quiet)
  Dim wasLocked
  wasLocked = fso.FileExists(BACKUP)
  CloseBrowser
  RestoreFile BACKUP
  RegDel RUNONCE
  If fso.FileExists(MBACKUP) And (elevated Or IsElevated()) Then RestoreMachine
  WScript.Sleep 1500
  CleanProfile
  If token <> "" Then Bye "PC put back to normal"
  Log "put back to normal"
  If Not quiet And wasLocked Then Say "The exam has ended. This PC is back to normal.", vbInformation
End Sub

Sub RestoreMachine()
  RestoreFile MBACKUP
  RunHidden "schtasks /Delete /F /TN """ & TASKNAME & """", True
  Log "machine settings put back"
End Sub

Sub Bye(reason)
  If token <> "" Then Http "POST", SERVER & "/__exam/agent/bye", "{""token"":""" & JEsc(token) & """,""reason"":""" & JEsc(reason) & """}"
End Sub

Function BeatJson()
  BeatJson = "{""token"":""" & JEsc(token) & """,""status"":{""ready"":" & JB(ready) & ",""browser"":" & JB(BrowserRunning()) & _
             ",""taskmgr"":" & JB(tmOff) & ",""admin"":" & JB(elevated) & ",""devtools"":" & JB(devOff) & _
             ",""usbblock"":" & JB(usbBlocked) & ",""usb"":""" & JEsc(UsbDrives()) & """,""screens"":" & CInt(screens) & _
             ",""problem"":""" & JEsc(problem) & """,""killed"":""" & JEsc(killedNow) & """,""relaunched"":" & CInt(relaunched) & "}}"
End Function

' ============================================================================ the exam browser
Function EdgePath()
  Dim p
  For Each p In Array(sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
                      sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
                      sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Microsoft\Edge\Application\msedge.exe")
    If fso.FileExists(p) Then
      EdgePath = p
      Exit Function
    End If
  Next
  EdgePath = ""
End Function

Function HostOf(url)
  Dim h
  h = Mid(url, InStr(url, "//") + 2)
  If InStr(h, "/") > 0 Then h = Left(h, InStr(h, "/") - 1)
  If InStr(h, ":") > 0 Then h = Left(h, InStr(h, ":") - 1)
  HostOf = h
End Function

Sub StartBrowser()
  Dim cmd
  ' Only the lab server is reachable: everything else goes to a proxy address where nothing answers.
  cmd = """" & edgeExe & """ --kiosk """ & SERVER & "/?foctk=" & kiosk & """ --edge-kiosk-type=fullscreen" & _
        " --no-first-run --no-default-browser-check --user-data-dir=""" & PROFILE & """" & _
        " --proxy-server=""127.0.0.1:9"" --proxy-bypass-list=""" & HostOf(SERVER) & ";<local>"""
  If testMode Then
    Log "test mode, would start: " & cmd
    WriteText HOME & "\kiosk-url.txt", SERVER & "/?foctk=" & kiosk
  Else
    sh.Run cmd, 1, False
    WScript.Sleep 2500
  End If
End Sub

Function BrowserRunning()
  If testMode Then
    BrowserRunning = True
    Exit Function
  End If
  Dim p
  BrowserRunning = False
  For Each p In wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name='msedge.exe'")
    If IsMain(p) And InStr(LCase(p.CommandLine & ""), LCase(PROFILE)) > 0 Then
      BrowserRunning = True
      Exit Function
    End If
  Next
End Function

Function IsMain(p)            ' the browser process itself, not one of its helper processes
  IsMain = (p.CommandLine & "") <> "" And InStr(LCase(p.CommandLine & ""), "--type=") = 0
End Function

Sub CloseBrowser()
  Dim p
  For Each p In wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='msedge.exe'")
    If InStr(LCase(p.CommandLine & ""), LCase(PROFILE)) > 0 Then
      If testMode Then
        Log "test mode, would close the exam browser " & p.ProcessId
      Else
        On Error Resume Next
        p.Terminate
        On Error GoTo 0
      End If
    End If
  Next
End Sub

Sub CleanProfile()
  If fso.FolderExists(PROFILE) Then
    On Error Resume Next
    fso.DeleteFolder PROFILE, True
    On Error GoTo 0
  End If
End Sub

' ============================================================================ programs, drives, screens
Sub KillSweep(first)
  Dim p, name
  For Each p In wmi.ExecQuery("SELECT ProcessId, ParentProcessId, Name, CommandLine FROM Win32_Process")
    name = LCase(p.Name & "")
    If p.ProcessId <> myPid And p.ParentProcessId <> myPid Then
      If InStr(killList, "," & name & ",") > 0 And InStr(NEVER, "," & name & ",") = 0 Then
        KillOne p, name
      ElseIf name = "msedge.exe" Then
        ' any Edge that is not the exam browser (on the first sweep, every Edge)
        If IsMain(p) And (first Or InStr(LCase(p.CommandLine & ""), LCase(PROFILE)) = 0) Then KillOne p, name
      End If
    End If
  Next
End Sub

Sub KillOne(p, name)
  If testMode Then
    Log "test mode, would close " & name & " (" & p.ProcessId & ")"
  Else
    On Error Resume Next
    p.Terminate
    On Error GoTo 0
  End If
  If InStr("," & killedNow & ",", "," & name & ",") = 0 Then
    If killedNow <> "" Then killedNow = killedNow & ","
    killedNow = killedNow & name
  End If
End Sub

Function UsbDrives()
  Dim d, out
  out = ""
  If testMode Then                                        ' test mode: a file stands in for a USB drive
    UsbDrives = Trim(Replace(Replace(ReadText(HOME & "\fake-usb.txt"), vbCr, ""), vbLf, ""))
    Exit Function
  End If
  On Error Resume Next
  For Each d In wmi.ExecQuery("SELECT DeviceID FROM Win32_LogicalDisk WHERE DriveType=2")
    out = out & d.DeviceID & " "
  Next
  If out = "" Then
    For Each d In wmi.ExecQuery("SELECT Index FROM Win32_DiskDrive WHERE InterfaceType='USB'")
      out = "USB disk"
    Next
  End If
  On Error GoTo 0
  UsbDrives = Trim(out)
End Function

Function ScreenCount()
  Dim f, n, t
  f = HOME & "\screens.txt"
  On Error Resume Next
  If fso.FileExists(f) Then fso.DeleteFile f, True
  On Error GoTo 0
  RunHidden "powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command ""Add-Type -AssemblyName System.Windows.Forms; " & _
            "[System.Windows.Forms.Screen]::AllScreens.Count | Out-File -Encoding ascii '" & f & "'""", True
  n = 0
  t = Trim(Replace(Replace(ReadText(f), vbCr, ""), vbLf, ""))
  If IsNumeric(t) And t <> "" Then n = CInt(t)
  ScreenCount = n
End Function

' ============================================================================ this process
' The script hosts (wscript/cscript) running this file and not just putting the PC back; the
' newest one is this copy.
Dim helperCount
Function OwnPid()
  Dim p, cl, newest
  OwnPid = 0
  helperCount = 0
  newest = ""
  For Each p In wmi.ExecQuery("SELECT ProcessId, CommandLine, CreationDate FROM Win32_Process WHERE Name='wscript.exe' OR Name='cscript.exe'")
    cl = LCase(p.CommandLine & "")
    If InStr(cl, LCase(WScript.ScriptName)) > 0 And InStr(cl, "/restore") = 0 Then
      helperCount = helperCount + 1
      If p.CreationDate & "" > newest Then
        newest = p.CreationDate & ""
        OwnPid = p.ProcessId
      End If
    End If
  Next
End Function

Function OtherHelperRunning()
  OtherHelperRunning = (helperCount > 1)
End Function

Function IsElevated()
  IsElevated = (sh.Run("cmd /c net session >nul 2>&1", 0, True) = 0)
End Function

Function IsAdminAccount()
  IsAdminAccount = (sh.Run("cmd /c whoami /groups | find ""S-1-5-32-544"" >nul", 0, True) = 0)
End Function

Function AskElevation()
  ' asks Windows for administrator rights (the PC shows its usual prompt); if granted, that copy carries on
  Dim flag, t
  flag = HOME & "\elevated.started"
  If fso.FileExists(flag) Then fso.DeleteFile flag, True
  On Error Resume Next
  CreateObject("Shell.Application").ShellExecute "wscript.exe", """" & WScript.ScriptFullName & """ /elevated", "", "runas", 1
  On Error GoTo 0
  AskElevation = False
  For t = 1 To 60
    WScript.Sleep 500
    If fso.FileExists(flag) Then
      AskElevation = True
      Exit Function
    End If
  Next
End Function

' ============================================================================ registry with a backup
' The backup file has one line per value: path|existed|type|value. Putting back writes the old
' value again, or deletes the value if it did not exist.
Function TestPath(path)        ' in test mode every change goes under HKCU\Software\FoCTExamTest
  If testMode Then
    TestPath = "HKCU\Software\FoCTExamTest\" & Replace(Replace(path, "HKCU\", "HKCU-"), "HKLM\", "HKLM-")
  Else
    TestPath = path
  End If
End Function

Function RegGet(path, ByRef exists)
  On Error Resume Next
  RegGet = sh.RegRead(TestPath(path))
  exists = (Err.Number = 0)
  Err.Clear
  On Error GoTo 0
End Function

Function RegSet(path, value, kind)
  On Error Resume Next
  sh.RegWrite TestPath(path), value, kind
  RegSet = (Err.Number = 0)
  If Err.Number <> 0 Then Log "could not set " & path & ": " & Err.Description
  Err.Clear
  On Error GoTo 0
End Function

Sub RegDel(path)
  On Error Resume Next
  sh.RegDelete TestPath(path)
  Err.Clear
  On Error GoTo 0
End Sub

Sub BackupValue(file, path)
  Dim v, exists, kind, f
  If InStr(ReadText(file), path & "|") > 0 Then Exit Sub   ' already saved: keep the first (real) value
  v = RegGet(path, exists)
  kind = "REG_SZ"
  If exists Then
    If VarType(v) = vbLong Or VarType(v) = vbInteger Then kind = "REG_DWORD"
  Else
    v = ""
  End If
  EnsureDir fso.GetParentFolderName(file)
  Set f = fso.OpenTextFile(file, 8, True)
  f.WriteLine path & "|" & CStr(exists) & "|" & kind & "|" & CStr(v)
  f.Close
End Sub

Sub RestoreFile(file)
  Dim lines, ln, parts
  If Not fso.FileExists(file) Then Exit Sub
  lines = Split(ReadText(file), vbCrLf)
  For Each ln In lines
    If ln <> "" Then
      parts = Split(ln, "|", 4)
      If UBound(parts) = 3 Then
        If LCase(parts(1)) = "true" Then
          If parts(2) = "REG_DWORD" Then RegSet parts(0), CLng(parts(3)), "REG_DWORD" Else RegSet parts(0), parts(3), "REG_SZ"
        Else
          RegDel parts(0)
        End If
      End If
    End If
  Next
  On Error Resume Next
  fso.DeleteFile file, True
  On Error GoTo 0
End Sub

' ============================================================================ small helpers
Function Http(method, url, body)
  Dim x
  Http = ""
  On Error Resume Next
  Set x = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  x.setTimeouts 5000, 5000, 10000, 10000
  x.open method, url, False
  x.setRequestHeader "Content-Type", "application/json"
  x.send body
  If Err.Number = 0 Then
    If x.status = 200 Then Http = x.responseText
  End If
  Err.Clear
  On Error GoTo 0
End Function

Function JStr(json, key)
  Dim re, m
  Set re = New RegExp
  re.Pattern = """" & key & """\s*:\s*""((?:[^""\\]|\\.)*)"""
  Set m = re.Execute(json)
  If m.Count > 0 Then JStr = JUnesc(m(0).SubMatches(0)) Else JStr = ""
End Function

Function JBool(json, key)
  Dim re, m
  Set re = New RegExp
  re.Pattern = """" & key & """\s*:\s*(true|false)"
  Set m = re.Execute(json)
  JBool = False
  If m.Count > 0 Then JBool = (m(0).SubMatches(0) = "true")
End Function

Function JUnesc(s)
  Dim re, m, out, pos
  Set re = New RegExp
  re.Global = True
  re.Pattern = "\\(u[0-9a-fA-F]{4}|.)"
  out = ""
  pos = 1
  For Each m In re.Execute(s)
    out = out & Mid(s, pos, m.FirstIndex + 1 - pos)
    Select Case Left(m.SubMatches(0), 1)
      Case "u": out = out & ChrW(CLng("&H" & Mid(m.SubMatches(0), 2)))
      Case "n": out = out & vbLf
      Case "r": out = out & vbCr
      Case "t": out = out & vbTab
      Case Else: out = out & m.SubMatches(0)
    End Select
    pos = m.FirstIndex + m.Length + 1
  Next
  JUnesc = out & Mid(s, pos)
End Function

Function JEsc(s)
  Dim r
  r = Replace(CStr(s & ""), "\", "\\")
  r = Replace(r, """", "\""")
  r = Replace(r, vbCr, "\r")
  r = Replace(r, vbLf, "\n")
  JEsc = r
End Function

Function JB(b)
  If b Then JB = "true" Else JB = "false"
End Function

Sub RunHidden(cmd, wait)
  If testMode And (InStr(cmd, "schtasks") > 0 Or InStr(cmd, "clip") > 0) Then
    Log "test mode, would run: " & cmd
    Exit Sub
  End If
  On Error Resume Next
  sh.Run cmd, 0, wait
  On Error GoTo 0
End Sub

Sub EnsureDir(path)
  If path = "" Then Exit Sub
  If Not fso.FolderExists(path) Then
    EnsureDir fso.GetParentFolderName(path)
    On Error Resume Next
    fso.CreateFolder path
    On Error GoTo 0
  End If
End Sub

Function ReadText(file)
  ReadText = ""
  If fso.FileExists(file) Then
    If fso.GetFile(file).Size > 0 Then ReadText = fso.OpenTextFile(file, 1).ReadAll
  End If
End Function

Sub WriteText(file, text)
  Dim f
  Set f = fso.OpenTextFile(file, 2, True)
  f.Write text
  f.Close
End Sub

Sub Log(text)
  Dim f
  On Error Resume Next
  Set f = fso.OpenTextFile(LOGFILE, 8, True)
  f.WriteLine Now & "  " & text
  f.Close
  On Error GoTo 0
End Sub

Sub Say(text, icon)
  Log "message: " & text
  If testMode Then Exit Sub
  MsgBox text, icon + SYSTEM_MODAL, APPNAME
End Sub

Function ArgList()
  Dim a(), k
  ReDim a(WScript.Arguments.Count)
  For k = 0 To WScript.Arguments.Count - 1
    a(k) = WScript.Arguments(k)
  Next
  ArgList = a
End Function
