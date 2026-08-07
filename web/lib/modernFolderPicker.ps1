$ErrorActionPreference = "Stop"

$source = @'
using System;
using System.Runtime.InteropServices;

public static class ModernFolderPicker
{
    [Flags]
    private enum FileOpenOptions : uint
    {
        NoChangeDirectory = 0x00000008,
        PickFolders = 0x00000020,
        ForceFileSystem = 0x00000040,
        PathMustExist = 0x00000800,
        DontAddToRecent = 0x02000000
    }

    private enum ShellItemDisplayName : uint
    {
        FileSystemPath = 0x80058000
    }

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialogComObject
    {
    }

    [ComImport]
    [Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig]
        int Show(IntPtr parent);

        void SetFileTypes(uint count, IntPtr filterSpec);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(FileOpenOptions options);
        void GetOptions(out FileOpenOptions options);
        void SetDefaultFolder(IShellItem shellItem);
        void SetFolder(IShellItem shellItem);
        void GetFolder(out IShellItem shellItem);
        void GetCurrentSelection(out IShellItem shellItem);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem shellItem);
        void AddPlace(IShellItem shellItem, int alignment);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr bindContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(ShellItemDisplayName displayName, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem shellItem, uint hint, out int order);
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    public static string Show()
    {
        IFileDialog dialog = null;
        IShellItem selectedItem = null;
        IntPtr pathPointer = IntPtr.Zero;

        try
        {
            dialog = (IFileDialog)new FileOpenDialogComObject();
            FileOpenOptions currentOptions;
            dialog.GetOptions(out currentOptions);
            dialog.SetOptions(
                currentOptions |
                FileOpenOptions.PickFolders |
                FileOpenOptions.ForceFileSystem |
                FileOpenOptions.PathMustExist |
                FileOpenOptions.NoChangeDirectory |
                FileOpenOptions.DontAddToRecent
            );
            dialog.SetTitle("Select workspace folder");
            dialog.SetOkButtonLabel("Choose folder");

            int result = dialog.Show(GetForegroundWindow());

            // HRESULT_FROM_WIN32(ERROR_CANCELLED)
            if (result == unchecked((int)0x800704C7))
            {
                return null;
            }

            if (result < 0)
            {
                Marshal.ThrowExceptionForHR(result);
            }

            dialog.GetResult(out selectedItem);
            selectedItem.GetDisplayName(
                ShellItemDisplayName.FileSystemPath,
                out pathPointer
            );

            return Marshal.PtrToStringUni(pathPointer);
        }
        finally
        {
            if (pathPointer != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(pathPointer);
            }

            if (selectedItem != null && Marshal.IsComObject(selectedItem))
            {
                Marshal.FinalReleaseComObject(selectedItem);
            }

            if (dialog != null && Marshal.IsComObject(dialog))
            {
                Marshal.FinalReleaseComObject(dialog);
            }
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$selectedPath = [ModernFolderPicker]::Show()

if (-not [string]::IsNullOrWhiteSpace($selectedPath)) {
    Write-Output $selectedPath
}
