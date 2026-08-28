' Starts the Claude Code usage feed with no console window.
'
' Task Scheduler's "Hidden" setting hides the task, not the window, so pointing
' a logon task straight at node.exe flashes a console on every sign-in. Running
' it through wscript with window style 0 is the standard way around that.
'
' Paths are derived from this script's own location, so moving the repo does not
' break the scheduled task.

Dim shell, fso, here, target

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
target = here & "\server.js"

If Not fso.FileExists(target) Then
    ' Surface a genuine misconfiguration rather than failing silently at logon.
    MsgBox "Claude usage feed: server.js not found at " & target, 16, "Claude Usage Feed"
    WScript.Quit 1
End If

shell.CurrentDirectory = here
' 0 = hidden window, False = do not wait for it to exit.
shell.Run "node.exe """ & target & """", 0, False
