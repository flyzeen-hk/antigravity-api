' Silent desktop launcher wrapper for Antigravity API (no console flash)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir   = fso.GetParentFolderName(scriptDir)
localNode = fso.BuildPath(fso.BuildPath(fso.BuildPath(rootDir, "runtime"), "node"), "node.exe")
launcher  = fso.BuildPath(scriptDir, "launcher.js")

extraArgs = ""
For Each a In WScript.Arguments
  extraArgs = extraArgs & " """ & a & """"
Next

Function HasCompatibleSystemNode()
  On Error Resume Next
  rc = sh.Run("cmd /c node -e ""process.exit(parseInt(process.versions.node,10)>=18?0:1)"" >nul 2>&1", 0, True)
  HasCompatibleSystemNode = (Err.Number = 0 And rc = 0)
  On Error GoTo 0
End Function

Function HasCompatibleLocalNode()
  If Not fso.FileExists(localNode) Then
    HasCompatibleLocalNode = False
    Exit Function
  End If
  On Error Resume Next
  rc = sh.Run("""" & localNode & """ -e ""process.exit(parseInt(process.versions.node,10)>=18?0:1)""", 0, True)
  HasCompatibleLocalNode = (Err.Number = 0 And rc = 0)
  On Error GoTo 0
End Function

If HasCompatibleLocalNode() Then
  sh.CurrentDirectory = rootDir
  sh.Run """" & localNode & """ """ & launcher & """" & extraArgs, 0, False
ElseIf HasCompatibleSystemNode() Then
  sh.CurrentDirectory = rootDir
  sh.Run "node """ & launcher & """" & extraArgs, 0, False
Else
  runBat = fso.BuildPath(rootDir, "run.bat")
  sh.CurrentDirectory = rootDir
  sh.Run "cmd /c """ & runBat & """" & extraArgs, 1, False
End If
