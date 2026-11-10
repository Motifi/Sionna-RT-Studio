namespace SionnaRTStudio;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        string? acceptanceDirectory = null;
        if (args is ["--acceptance", var directory])
        {
            acceptanceDirectory = Path.GetFullPath(directory);
            Directory.CreateDirectory(acceptanceDirectory);
            if (Directory.EnumerateFileSystemEntries(acceptanceDirectory).Any())
                return 2;
        }
        else if (args.Length != 0)
        {
            return 2;
        }

        // Keep the localStorage origin stable across normal app launches.
        var firstInstance = true;
        using var instance = acceptanceDirectory is null
            ? new Mutex(true, @"Local\SionnaRTStudio.Desktop", out firstInstance)
            : null;
        if (!firstInstance)
        {
            MessageBox.Show("Sionna RT Studio is already open.\nSionna RT Studio 已打开。",
                "Sionna RT Studio", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }

        using var window = new StudioWindow(acceptanceDirectory);
        Application.Run(window);
        return window.ResultCode;
    }
}
