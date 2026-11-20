' FoCT Virtual Labs - exam helper for Windows 10 and 11
'
' Run it (double-click) when your teacher starts an exam that needs it. While the exam runs it:
'   - closes other programs (editors, other browsers, chat, remote-desktop, screenshot and
'     terminal tools) and keeps them closed;
'   - opens the exam in Microsoft Edge, full screen, with no address bar, no tabs and no
'     internet (only the lab server can be reached);
'   - turns off Task Manager and the clipboard history (if the teacher chose that);
'   - with administrator rights, when this PC allows them: turns off the developer tools in Edge
'     and Chrome, blocks USB drives, and cuts the PC off from the internet while the lab network
'     keeps working (if the PC restarts, the internet is back at once);
'   - tells the lab server every few seconds what it sees (USB drives, a second screen, programs
'     it had to close). The lab server lets this PC take part in the exam only while it runs;
'   - if the lab has several servers and this one stops answering, moves the exam to the next one
'     (the student signs in there again; what was sent before stays on the first server).
' It needs no administrator rights, and everything it changes it puts back: when the teacher ends
' the exam, or at the next sign-in if the PC restarts first. To put the PC back by hand, run it
' with /restore.
'
'   exam-helper.vbs            start (asks first)
'   exam-helper.vbs /restore   put this PC back to normal
'   exam-helper.vbs /test      try it out: talks to the server but changes nothing on this PC
'
' The lab server fills in its address below when the file is downloaded from it, and the lab's
' other servers after it.
Option Explicit

Const SERVER = "__FOCT_SERVER__"
Const SERVER_LIST = "__FOCT_SERVERS__"
Const VERSION = "3"
Const APPNAME = "FoCT exam helper"
Const BEAT_MS = 3000
Const MOVE_AFTER_S = 30                                   ' seconds without an answer before moving to another server
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

Dim HOME, MHOME, BACKUP, MBACKUP, ROUTES, LOGFILE, PROFILE, RUNONCE, TASKNAME
If testMode Then
  HOME = sh.ExpandEnvironmentStrings("%TEMP%") & "\FoCTExamTest"
  MHOME = HOME & "\machine"
Else
  HOME = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\FoCTExam"
  MHOME = sh.ExpandEnvironmentStrings("%ProgramData%") & "\FoCTExam"
End If
BACKUP = HOME & "\backup.txt"
MBACKUP = MHOME & "\backup-machine.txt"
ROUTES = MHOME & "\routes.txt"                            ' routes taken out to cut off the internet
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

Dim token, kiosk, title, killList, optTaskmgr, optAdmin, optInternet, myPid, elevated, edgeExe
Dim tmOff, devOff, usbBlocked, netOff, netBlocking, routesOk, problem, killedNow, relaunched, screens, lastScreens, ready, beats
' labServer: the lab server this PC takes the exam on now; labServers: every one known, this first.
' cameFrom: the server it moved away from; routeIf/routeGw: the way to the lab's other subnets.
Dim labServer, labServers, cameFrom, moves, routeIf, routeGw
labServer = SERVER
labServers = ""
AddServers SERVER
If InStr(SERVER_LIST, "__FOCT") = 0 Then AddServers SERVER_LIST

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
  If InStr(SERVER, "__FOCT") > 0 Then                     ' not downloaded from a lab server: no address in it
    Say "This copy of the exam helper does not know the lab server. Download it from the lab server's exam page.", vbExclamation
    Exit Sub
  End If
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

  resp = Connect(False)                                    ' this lab server, or else one of the others
  If resp = "" Then
    Say "The lab server (" & Replace(labServers, " ", ", ") & ") cannot be reached. Check the network and try again.", vbExclamation
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
    If optInternet Then msg = msg & "  - cut this PC off from the internet (the lab network keeps working)" & vbCrLf
    msg = msg & vbCrLf & "Your PC goes back to normal when the exam ends, or when it restarts." & vbCrLf & vbCrLf & "Start the exam?"
    If MsgBox(msg, vbOKCancel + vbQuestion + SYSTEM_MODAL, APPNAME) <> vbOK Then
      Bye "cancelled by the student"
      Exit Sub
    End If
  End If

  elevated = IsElevated()
  If testMode Then elevated = optAdmin Or optInternet     ' try the administrator part too (on test keys)
  If (optAdmin Or optInternet) And Not elevated And Not elevatedArg And Not testMode And IsAdminAccount() Then
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
  optInternet = JBool(resp, "internet")
  AddServers JStr(resp, "servers")
  If testMode Then WriteText HOME & "\token.txt", token
End Sub

Function Hello(url)
  Hello = Http("POST", url & "/__exam/agent/hello", "{""pc"":""" & JEsc(sh.ExpandEnvironmentStrings("%COMPUTERNAME%")) & _
          """,""user"":""" & JEsc(sh.ExpandEnvironmentStrings("%USERNAME%")) & """,""version"":""" & VERSION & _
          """,""from"":""" & JEsc(cameFrom) & """}")
End Function

Function Connect(skipCurrent)
  ' Says hello to the lab servers in turn (the current one first, unless skipCurrent) until one runs
  ' an exam with the helper, and makes that one the current server. Returns its answer; if none
  ' runs one, the first answer that came (it says why); "" if no server answered at all.
  Dim s, r, order, firstNo
  order = labServer
  For Each s In Split(labServers, " ")
    If LCase(s) <> LCase(labServer) Then order = order & " " & s
  Next
  firstNo = ""
  For Each s In Split(order, " ")
    If s <> "" And Not (skipCurrent And LCase(s) = LCase(labServer)) Then
      r = Hello(s)
      If r <> "" Then
        If JBool(r, "ok") Then
          labServer = s
          Connect = r
          Exit Function
        End If
        If firstNo = "" Then firstNo = r
      End If
    End If
  Next
  Connect = firstNo
End Function

Function MoveServer()
  ' The lab server stopped answering: carry on with another one that runs the exam. The exam window
  ' opens there with that server's key; the student signs in again.
  Dim old, r
  MoveServer = False
  old = labServer
  cameFrom = old
  r = Connect(True)
  If r = "" Then Exit Function
  If Not JBool(r, "ok") Then Exit Function
  moves = moves + 1
  Log "lab server " & old & " stopped answering: moving to " & labServer
  ReadSettings r
  If netBlocking Then KeepLabRoutes
  CloseBrowser
  WScript.Sleep 1500
  StartBrowser
  MoveServer = True
End Function

Sub AddServers(text)
  ' adds lab server addresses (separated by spaces or commas) to the known ones, in order
  Dim s
  For Each s In Split(Replace(Trim(text & ""), ",", " "), " ")
    s = Trim(s)
    If Right(s, 1) = "/" Then s = Left(s, Len(s) - 1)
    If LCase(Left(s, 7)) = "http://" Or LCase(Left(s, 8)) = "https://" Then
      If InStr(" " & LCase(labServers) & " ", " " & LCase(s) & " ") = 0 Then labServers = Trim(labServers & " " & s)
    End If
  Next
End Sub

Sub LearnServers(text)
  ' a server named another one: it must stay reachable too when the internet is cut off
  Dim before
  before = labServers
  AddServers text
  If labServers <> before Then
    Log "lab servers now: " & labServers
    If netBlocking Then KeepLabRoutes
  End If
End Sub

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
    If Not tmOff Then AddProblem "Task Manager could not be turned off"
  End If
  If elevated And (optAdmin Or optInternet) Then
    EnsureDir MHOME
    If LCase(WScript.ScriptFullName) <> LCase(MHOME & "\exam-helper.vbs") Then fso.CopyFile WScript.ScriptFullName, MHOME & "\exam-helper.vbs", True
    ' If the PC restarts during the exam (a power cut too), Windows puts these back at start-up. Set
    ' up before anything changes, so that no change is ever without its way back.
    RunHidden "schtasks /Create /F /RU SYSTEM /SC ONSTART /TN """ & TASKNAME & """ /TR ""wscript.exe //B \""" & MHOME & "\exam-helper.vbs\"" /restore-machine""", True
    If optAdmin Then
      BackupValue MBACKUP, EDGE_DEVTOOLS
      BackupValue MBACKUP, CHROME_DEVTOOLS
      BackupValue MBACKUP, USB_DENY
      devOff = RegSet(EDGE_DEVTOOLS, 2, "REG_DWORD")
      RegSet CHROME_DEVTOOLS, 2, "REG_DWORD"
      usbBlocked = RegSet(USB_DENY, 1, "REG_DWORD")
    End If
  End If
  If optInternet Then
    If elevated Then
      NetBlock
    Else
      AddProblem "internet not cut off (no administrator rights)"
    End If
  End If
  RunHidden "cmd /c echo off| clip", True                 ' empty the clipboard
  KillSweep True                                          ' every other browser too, before the exam browser starts
  CleanProfile
  StartBrowser
  ready = True
  Log "locked down: taskmgr=" & tmOff & " admin=" & elevated & " devtools=" & devOff & " usbblock=" & usbBlocked & " internet off=" & netOff
End Sub

Sub RunExam()
  Dim resp, lastContact, lastTry
  lastContact = Now                                       ' the last answer from any lab server
  lastTry = Now                                           ' ... or the last attempt to move to another one
  screens = ScreenCount()
  Do
    killedNow = ""
    KillSweep False
    If Not BrowserRunning() Then
      relaunched = relaunched + 1
      Log "exam browser was closed: opening it again"
      StartBrowser
    End If
    If netBlocking Then NetKeepOff
    beats = beats + 1
    If beats Mod 10 = 0 Then screens = ScreenCount()
    resp = Http("POST", labServer & "/__exam/agent/beat", BeatJson())
    If resp <> "" Then
      lastContact = Now
      lastTry = Now
      If Not JBool(resp, "known") Then                    ' the server forgot this PC (restarted): introduce it again
        Dim r2
        r2 = Hello(labServer)
        If JBool(r2, "ok") Then ReadSettings r2
      Else
        killList = "," & Replace(LCase(JStr(resp, "kill")), " ", "") & ","
        LearnServers JStr(resp, "servers")
      End If
      If JBool(resp, "end") Then
        Log "the exam has ended"
        Exit Do
      End If
    Else
      ' This server does not answer. With others in the lab, move to one that runs the exam
      ' (tried again every MOVE_AFTER_S seconds while none does).
      If InStr(labServers, " ") > 0 And DateDiff("s", lastTry, Now) >= MOVE_AFTER_S Then
        lastTry = Now
        If MoveServer() Then lastContact = Now
      End If
      If DateDiff("n", lastContact, Now) >= 30 Then
        Log "no contact with any lab server for 30 minutes: putting the PC back"
        Exit Do
      End If
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
  If (fso.FileExists(MBACKUP) Or fso.FileExists(ROUTES)) And (elevated Or IsElevated()) Then RestoreMachine
  WScript.Sleep 1500
  CleanProfile
  If token <> "" Then Bye "PC put back to normal"
  Log "put back to normal"
  If Not quiet And wasLocked Then Say "The exam has ended. This PC is back to normal.", vbInformation
End Sub

Sub RestoreMachine()
  NetRestore
  RestoreFile MBACKUP
  RunHidden "schtasks /Delete /F /TN """ & TASKNAME & """", True
  Log "machine settings put back"
End Sub

Sub Bye(reason)
  If token <> "" Then Http "POST", labServer & "/__exam/agent/bye", "{""token"":""" & JEsc(token) & """,""reason"":""" & JEsc(reason) & """}"
End Sub

Function BeatJson()
  BeatJson = "{""token"":""" & JEsc(token) & """,""status"":{""ready"":" & JB(ready) & ",""browser"":" & JB(BrowserRunning()) & _
             ",""taskmgr"":" & JB(tmOff) & ",""admin"":" & JB(elevated) & ",""devtools"":" & JB(devOff) & _
             ",""usbblock"":" & JB(usbBlocked) & ",""netoff"":" & JB(netOff) & _
             ",""usb"":""" & JEsc(UsbDrives()) & """,""screens"":" & CInt(screens) & _
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
  Dim cmd, url, bypass, s
  ' Only the lab servers are reachable: everything else goes to a proxy address where nothing answers.
  url = labServer & "/?foctk=" & kiosk
  bypass = ""
  For Each s In Split(labServers, " ")
    If s <> "" Then bypass = bypass & HostOf(s) & ";"
  Next
  cmd = """" & edgeExe & """ --kiosk """ & url & """ --edge-kiosk-type=fullscreen" & _
        " --no-first-run --no-default-browser-check --user-data-dir=""" & PROFILE & """" & _
        " --proxy-server=""127.0.0.1:9"" --proxy-bypass-list=""" & bypass & "<local>"""
  If testMode Then
    Log "test mode, would start: " & cmd
    WriteText HOME & "\kiosk-url.txt", url
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

' ============================================================================ internet off, lab network on
' Only the PC's active routing table changes, never its network settings. The default routes (the
' way to the internet) are taken out; PCs on the lab's own subnet need no route, so the lab network
' keeps working, and the lab server gets a route of its own if it is on another subnet. Windows
' rebuilds the active table from the network settings at every start, so a restart brings the
' internet back by itself; at the end of the exam the routes taken out are put back. ROUTES lists
' the changes: "boot|<start time>", then "cut|family|interface|prefix|next hop|metric" for each
' default route taken out and "kept|family|interface|prefix|next hop" for each route added.
Sub NetBlock()
  Dim tries, answered
  If fso.FileExists(ROUTES) Then NetRestore               ' left over from an earlier run
  EnsureDir MHOME
  WriteText ROUTES, "boot|" & BootTime() & vbCrLf
  KeepLabRoutes
  NetCut
  netOff = testMode Or (DefaultRoutes() = "" And routesOk)
  netBlocking = True
  ' The lab server must still answer. If it does not, give the internet back rather than lose the exam.
  answered = False
  For tries = 1 To 3
    If Http("POST", labServer & "/__exam/agent/beat", BeatJson()) <> "" Then
      answered = True
      Exit For
    End If
    WScript.Sleep 1000
  Next
  If Not answered Then
    NetRestore
    AddProblem "internet not cut off: without it the lab server could not be reached"
  ElseIf Not netOff Then
    AddProblem "the internet could not be cut off completely"
  End If
End Sub

Sub NetCut()
  ' takes every default route out of the active table, noting each one first so it can be put back
  Dim ln, p, saved
  saved = ReadText(ROUTES)
  For Each ln In Split(DefaultRoutes(), vbLf)
    p = Split(ln, "|")                                    ' family|interface|prefix|next hop|metric
    If UBound(p) = 4 Then
      If InStr(saved, "cut|" & ln & vbCrLf) = 0 Then AppendText ROUTES, "cut|" & ln
      RouteCmd "delete", p(0), p(1), p(2), p(3), ""
    End If
  Next
End Sub

Sub NetKeepOff()
  ' a default route came back (network cable plugged in again, a Wi-Fi network joined): out it goes
  If testMode Then Exit Sub
  If DefaultRoutes() <> "" Then
    Log "a default route came back: taking it out again"
    NetCut
    netOff = (DefaultRoutes() = "" And routesOk)
  ElseIf routesOk Then
    netOff = True
  End If
End Sub

Sub NetRestore()
  ' puts back the routes taken out for the exam; after a restart Windows has done that already
  Dim text, ln, p
  netBlocking = False
  netOff = False
  If Not fso.FileExists(ROUTES) Then Exit Sub
  text = ReadText(ROUTES)
  If InStr(text, "boot|" & BootTime() & vbCrLf) > 0 Then
    For Each ln In Split(text, vbCrLf)
      p = Split(ln, "|")
      If UBound(p) = 5 Then
        If p(0) = "cut" Then RouteCmd "add", p(1), p(2), p(3), p(4), p(5)
      End If
    Next
    For Each ln In Split(text, vbCrLf)
      p = Split(ln, "|")
      If UBound(p) = 4 Then
        If p(0) = "kept" Then RouteCmd "delete", p(1), p(2), p(3), p(4), ""
      End If
    Next
    Log "internet routes put back"
  Else
    Log "the PC has restarted since the internet was cut off: its routes are back already"
  End If
  On Error Resume Next
  fso.DeleteFile ROUTES, True
  On Error GoTo 0
End Sub

Sub KeepLabRoutes()
  ' The lab servers, and the DNS servers when a server goes by name, must stay reachable without a
  ' default route: those on another subnet get a route through the gateway the PC used before.
  ' (Run again when another server becomes known: the gateway is remembered from the first time.)
  Dim host, list, a, best, ifx, gw, s
  list = ""
  For Each s In Split(labServers, " ")
    If s <> "" Then
      host = HostOf(s)
      If IsIPv4(host) Then list = list & " " & host Else list = list & " " & Resolve(host) & " " & DnsServers()
    End If
  Next
  best = BestIPv4Default()                                ' interface|gateway
  If best <> "" Then
    routeIf = Split(best, "|")(0)
    routeGw = Split(best, "|")(1)
  End If
  If routeIf & "" = "" Then Exit Sub
  ifx = routeIf
  gw = routeGw
  For Each a In Split(Trim(list), " ")
    If IsIPv4(a) And Left(a, 4) <> "127." Then
      If Not OnLink(a) And InStr(ReadText(ROUTES), "|" & a & "/32|") = 0 Then
        AppendText ROUTES, "kept|4|" & ifx & "|" & a & "/32|" & gw
        RouteCmd "add", "4", ifx, a & "/32", gw, ""
      End If
    End If
  Next
End Sub

Function DefaultRoutes()
  ' the default routes (IPv4 and IPv6) of the active routing table, one line each:
  ' family|interface|prefix|next hop|metric. routesOk says whether the table could be read.
  Dim svc, rs, r, out, fam
  out = ""
  routesOk = False
  On Error Resume Next
  Set svc = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\StandardCimv2")
  If Err.Number = 0 Then Set rs = svc.ExecQuery("SELECT DestinationPrefix, InterfaceIndex, NextHop, RouteMetric, AddressFamily FROM MSFT_NetRoute WHERE DestinationPrefix='0.0.0.0/0' OR DestinationPrefix='::/0'")
  If Err.Number = 0 Then
    For Each r In rs
      If Err.Number <> 0 Then Exit For
      If r.AddressFamily = 2 Then fam = "4" Else fam = "6"
      If out <> "" Then out = out & vbLf
      out = out & fam & "|" & r.InterfaceIndex & "|" & r.DestinationPrefix & "|" & r.NextHop & "|" & r.RouteMetric
    Next
    routesOk = (Err.Number = 0)
  End If
  If Not routesOk Then Log "could not read the routing table: " & Err.Description
  Err.Clear
  On Error GoTo 0
  DefaultRoutes = out
End Function

Function BestIPv4Default()
  ' interface|gateway of the IPv4 default route Windows prefers (lowest total metric)
  Dim r, low
  BestIPv4Default = ""
  low = -1
  On Error Resume Next
  For Each r In wmi.ExecQuery("SELECT InterfaceIndex, NextHop, Metric1 FROM Win32_IP4RouteTable WHERE Destination='0.0.0.0' AND Mask='0.0.0.0'")
    If low < 0 Or r.Metric1 < low Then
      low = r.Metric1
      BestIPv4Default = r.InterfaceIndex & "|" & r.NextHop
    End If
  Next
  On Error GoTo 0
End Function

Sub RouteCmd(verb, family, ifx, prefix, nexthop, metric)
  ' store=active: the change lasts until the PC restarts. (Without it, netsh would change the
  ' PC's network settings too, and deleting a route would delete the gateway for good.)
  Dim cmd
  cmd = "netsh interface ipv" & family & " " & verb & " route prefix=" & prefix & " interface=" & ifx
  If nexthop <> "" And nexthop <> "0.0.0.0" And nexthop <> "::" Then cmd = cmd & " nexthop=" & nexthop
  If metric <> "" Then cmd = cmd & " metric=" & metric
  cmd = cmd & " store=active"
  If Not testMode Then Log cmd
  RunHidden cmd, True
End Sub

Function OnLink(ip)
  ' whether an IPv4 address is on one of this PC's own subnets (reachable without a gateway)
  Dim cfg, k, j, a, b, m, same
  OnLink = False
  a = Split(ip, ".")
  On Error Resume Next
  For Each cfg In wmi.ExecQuery("SELECT IPAddress, IPSubnet FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled=TRUE")
    If Not (IsNull(cfg.IPAddress) Or IsNull(cfg.IPSubnet)) Then
      For k = 0 To UBound(cfg.IPAddress)
        If IsIPv4(cfg.IPAddress(k)) And IsIPv4(cfg.IPSubnet(k)) Then
          b = Split(cfg.IPAddress(k), ".")
          m = Split(cfg.IPSubnet(k), ".")
          same = True
          For j = 0 To 3
            If (CInt(a(j)) And CInt(m(j))) <> (CInt(b(j)) And CInt(m(j))) Then same = False
          Next
          If same Then OnLink = True
        End If
      Next
    End If
  Next
  On Error GoTo 0
End Function

Function IsIPv4(s)
  Dim re
  Set re = New RegExp
  re.Pattern = "^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$"
  IsIPv4 = re.Test(s & "")
End Function

Function Resolve(host)
  ' the address Windows finds for a name (no ping needs to come back for that)
  Dim p
  Resolve = ""
  On Error Resume Next
  For Each p In wmi.ExecQuery("SELECT ProtocolAddress FROM Win32_PingStatus WHERE Address='" & Replace(host, "'", "") & "'")
    Resolve = p.ProtocolAddress & ""
  Next
  On Error GoTo 0
End Function

Function DnsServers()
  Dim cfg, out
  out = ""
  On Error Resume Next
  For Each cfg In wmi.ExecQuery("SELECT DNSServerSearchOrder FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled=TRUE")
    If Not IsNull(cfg.DNSServerSearchOrder) Then out = out & " " & Join(cfg.DNSServerSearchOrder, " ")
  Next
  On Error GoTo 0
  DnsServers = Trim(out)
End Function

Function BootTime()
  ' when Windows last started: tells whether a restart has put the routes back already
  Dim o
  BootTime = ""
  On Error Resume Next
  For Each o In wmi.ExecQuery("SELECT LastBootUpTime FROM Win32_OperatingSystem")
    BootTime = o.LastBootUpTime & ""
  Next
  On Error GoTo 0
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
  If testMode And (InStr(cmd, "schtasks") > 0 Or InStr(cmd, "clip") > 0 Or InStr(cmd, "netsh") > 0) Then
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

Sub AppendText(file, line)
  Dim f
  Set f = fso.OpenTextFile(file, 8, True)
  f.WriteLine line
  f.Close
End Sub

Sub AddProblem(text)
  ' reported to the teacher's control page with every beat
  If problem <> "" Then problem = problem & "; "
  problem = problem & text
  Log "problem: " & text
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
