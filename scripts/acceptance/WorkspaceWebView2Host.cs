// Dedicated test host: never attaches to the installed application's WebView/profile.
using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class WorkspaceWebView2Host : Form
{
    private readonly WebView2 view = new WebView2();
    private readonly string url;
    private readonly string output;
    private readonly bool profile;

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length != 3) { Environment.ExitCode = 2; return; }
        Uri uri;
        if (!Uri.TryCreate(args[0], UriKind.Absolute, out uri) || uri.Scheme != "http" ||
            uri.Host != "127.0.0.1" || uri.AbsolutePath != "/e2e/harness/workspace.html")
        { Environment.ExitCode = 2; return; }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new WorkspaceWebView2Host(args[0], args[1], args[2] == "profile"));
    }

    private WorkspaceWebView2Host(string target, string directory, bool collectProfile)
    {
        url = target;
        output = Path.GetFullPath(directory);
        profile = collectProfile;
        Text = "Workspace WebView2 acceptance (isolated test host)";
        ClientSize = new Size(1280, 800);
        view.Dock = DockStyle.Fill;
        Controls.Add(view);
        Shown += async delegate { await Run(); };
    }

    private async Task WaitFor(string expression, int seconds)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < deadline)
        {
            if (await view.ExecuteScriptAsync(expression) == "true") return;
            await Task.Delay(100);
        }
        throw new TimeoutException("Timed out waiting for: " + expression);
    }

    private async Task Run()
    {
        try
        {
            Directory.CreateDirectory(output);
            string userData = Path.Combine(output, "profile");
            // Override ambient profile/browser flags in this test process only.
            Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", userData);
            Environment.SetEnvironmentVariable("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", null);
            Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", null);
            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userData, null);
            await view.EnsureCoreWebView2Async(environment);
            view.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
            {
                Uri next;
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out next) || next.Scheme != "http" ||
                    next.Host != "127.0.0.1" || next.Port != new Uri(url).Port) e.Cancel = true;
            };
            view.CoreWebView2.Navigate(url);
            await WaitFor("Boolean(window.workspaceAcceptance && window.workspaceAcceptance.ready())", 90);
            File.WriteAllText(Path.Combine(output, "runtime.txt"),
                "Scope: dedicated native WebView2 host, real Workspace/xterm, mocked Tauri transport; not installed application or live PTY acceptance." + Environment.NewLine +
                "Runtime: " + environment.BrowserVersionString + Environment.NewLine +
                "Profile: " + userData + Environment.NewLine + "URL: " + url + Environment.NewLine);
            File.WriteAllText(Path.Combine(output, "viewport.json"), await view.ExecuteScriptAsync(
                "({width:innerWidth,height:innerHeight,visibility:document.visibilityState,userAgent:navigator.userAgent})"));
            for (int run = 0; run < 2; run++)
            {
                string name = run == 0 ? "cold" : "warm";
                if (profile)
                {
                    await view.CoreWebView2.CallDevToolsProtocolMethodAsync("Profiler.enable", "{}");
                    await view.CoreWebView2.CallDevToolsProtocolMethodAsync("Profiler.start", "{}");
                }
                await view.ExecuteScriptAsync("window.__nativeAcceptanceResult=null; window.__nativeAcceptanceError=null; window.workspaceAcceptance.run().then(function(result){window.__nativeAcceptanceResult=result;}).catch(function(error){window.__nativeAcceptanceError=String(error.stack||error);}); void 0;");
                await WaitFor("window.__nativeAcceptanceResult !== null || window.__nativeAcceptanceError !== null", 180);
                string error = await view.ExecuteScriptAsync("window.__nativeAcceptanceError");
                if (error != "null") throw new Exception(error);
                File.WriteAllText(Path.Combine(output, name + ".json"), await view.ExecuteScriptAsync("window.__nativeAcceptanceResult"));
                if (profile)
                {
                    File.WriteAllText(Path.Combine(output, name + "-profile.json"),
                        await view.CoreWebView2.CallDevToolsProtocolMethodAsync("Profiler.stop", "{}"));
                    await view.CoreWebView2.CallDevToolsProtocolMethodAsync("Profiler.disable", "{}");
                }
                await Task.Delay(1000);
            }
        }
        catch (Exception error)
        {
            Directory.CreateDirectory(output);
            File.WriteAllText(Path.Combine(output, "error.txt"), error.ToString());
            Environment.ExitCode = 1;
        }
        finally { view.Dispose(); Close(); }
    }
}
