// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { getProjectIds } from "./jsii/fetcher";
import { ProjenInfo } from "./projen_info";
import { ProjenView } from "./projen_view";
import { ProjenWatcher } from "./projen_watcher";

function useTerminal() {
  return vscode.workspace
    .getConfiguration("projen")
    .get("tasks.executeInTerminal");
}

function availableProjectLibraries() {
  const fromConfig =
    vscode.workspace
      .getConfiguration("projen")
      .get("projects.externalLibraries") ?? "";

  const externalOptions = `${fromConfig}\n[External Library...]`.trim();

  return [
    "Projen",
    ...externalOptions.split("\n"),
    // None of these seem to work with the current projen version :(
    // "@cdktf/provider-project | To create prebuilt provider packages for Terraform CDK",
    // "cdk-appsync-project | AWS AppSync API project that uses the cdk-appsync-transformer",
    // "@svelte-up/projen-rust-project | Cargo-based rustlang projects",
    // "p6-projen-project-awesome-list | Setup an Awesome List repository",
    // "yarn-projen | Manage monorepos using Yarn workspaces",
    // "lerna-projen | Manage monorepos using Lern",
  ];
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  if (!vscode.workspace.workspaceFolders?.[0]) {
    return;
  }

  let projects: ProjenInfo[] = [];
  for (const folder of vscode.workspace.workspaceFolders) {
    const folderProjects = await findProjectInFolder(folder);
    const filteredProjects = folderProjects
      .filter((f) => {
        if (projects.some((p) => p.projectRoot.path === f.path)) {
          return false;
        } else {
          return true;
        }
      })
      .map((p) => new ProjenInfo(folder, p));

    projects.push(...filteredProjects);
  }
  projects.sort((a, b) => a.label.localeCompare(b.label));

  const singleProject = projects.length === 1;

  async function quickPickProject() {
    if (singleProject) {
      return projects[0];
    }
    const selection = await vscode.window.showQuickPick(
      projects.map((t) => t.label),
      { placeHolder: "Select projent project" }
    );

    return projects.find((p) => p.label === selection)!;
  }

  function newOrActiveTerminal(projenInfo: ProjenInfo) {
    const terminalName = singleProject
      ? `[projen]`
      : `[projen][${projenInfo.label}]`;

    let terminal = vscode.window.terminals.find((t) => t.name === terminalName);
    if (!terminal) {
      terminal = vscode.window.createTerminal(terminalName);
    } else if (
      vscode.workspace
        .getConfiguration("projen")
        .get("terminal.alwaysChangeToWorkspaceDirectory")
    ) {
      terminal.sendText(getCDCommand(projenInfo.projectRoot));
    }

    terminal.show();
    return terminal;
  }

  function getVSCodeTask(
    projenInfo: ProjenInfo,
    name: string,
    ...args: string[]
  ) {
    args.unshift("projen");

    const taskName = singleProject ? name : `${name} [${projenInfo.label}]`;

    return new vscode.Task(
      { type: "projen", task: taskName },
      vscode.TaskScope.Workspace,
      taskName,
      "projen",
      new vscode.ProcessExecution("npx", args, {
        cwd: projenInfo.projectRoot.fsPath,
      }),
      // TODO: Use dynamic problem matchers
      ["$tsc", "$eslint-compact"]
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("projen.openProjenRc", async () => {
      const projenInfo = await quickPickProject();

      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(projenInfo.projectRoot, ".projenrc.{ts,js}")
      );

      if (files.length > 0) {
        const doc = await vscode.workspace.openTextDocument(files[0]);
        await vscode.window.showTextDocument(doc);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("projen.run", async () => {
      const projenInfo = await quickPickProject();
      if (useTerminal()) {
        newOrActiveTerminal(projenInfo).sendText(`npx projen`);
      } else {
        void vscode.tasks.executeTask(getVSCodeTask(projenInfo, "projen"));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projen.new",
      async (projectLib?: string, projectType?: string) => {
        const rawProjectLibSelection: string | undefined =
          projectLib ??
          (await vscode.window.showQuickPick(availableProjectLibraries(), {
            title: "Project Library",
            placeHolder: "Select library to view available projects",
          }));

        if (!rawProjectLibSelection) {
          return;
        }

        let projectLibSelection = rawProjectLibSelection
          .toLowerCase()
          .split("|")[0]
          .trim();

        if (projectLibSelection === "[external library...]") {
          const customLib = await vscode.window.showInputBox({
            prompt: "Specify external library",
            title: "External Library Selection",
          });

          if (!customLib) {
            return;
          }

          projectLibSelection = customLib.toLowerCase().trim();
        }

        let projectTypes = projectType
          ? []
          : await getProjectIds(projectLibSelection);

        let projectId: string | undefined = projectType;

        if (projectTypes.length > 1) {
          // If there are multiple projectTypes, we need a pjid
          projectTypes = projectTypes.filter((p) => !!p.pjid);
        }

        if (projectTypes.length === 0 && !projectType) {
          void vscode.window.showErrorMessage(
            `Unable to find available project types from "${projectLibSelection}"`
          );
          return;
        }

        if (projectTypes.length > 0) {
          const projectPickerPromise = new Promise<string | undefined>(
            (resolve) => {
              const picker = vscode.window.createQuickPick();
              picker.canSelectMany = false;
              picker.title = "Project Type Selection";
              picker.placeholder = "Select project type";
              picker.matchOnDetail = true;
              picker.items = projectTypes.map((project) => ({
                detail: project.pjid ?? "",
                label: project.summary ?? project.typeName,
              }));

              picker.onDidAccept(() => {
                if (picker.selectedItems && picker.selectedItems.length > 0) {
                  resolve(picker.selectedItems[0].detail);
                  picker.hide();
                }
              });
              picker.onDidHide(() => {
                resolve(undefined);
                picker.dispose();
              });

              picker.show();
            }
          );

          projectId = await projectPickerPromise;
        }

        if (projectId === undefined) {
          return;
        }

        const additionalArgs = await vscode.window.showInputBox({
          prompt: "(Optional) Additional arguments to pass to 'projen new'",
        });

        if (additionalArgs === undefined) {
          return;
        }

        let args = "";
        if (projectLibSelection !== "projen") {
          args += ` --from ${projectLibSelection}`;
        }
        if (projectId) {
          args += " " + projectId;
        }
        if (additionalArgs) {
          args += " " + additionalArgs;
        }
        args = args.trim();

        const terminal = vscode.window.createTerminal("[projen]");
        terminal.sendText(`npx projen new ${args}`);
      }
    )
  );

  const overview = new ProjenView(projects);
  vscode.window.createTreeView("projenProjects", {
    treeDataProvider: overview,
    showCollapseAll: true,
  });

  vscode.tasks.registerTaskProvider("projen", {
    provideTasks(_token?: vscode.CancellationToken) {
      return projects.flatMap((p) => {
        return p.tasks.map((t) => getVSCodeTask(p, t.name, t.name));
      });
    },
    resolveTask(task: vscode.Task, _token?: vscode.CancellationToken) {
      return task;
    },
  });

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projen.runTask",
      async (projenInfo?: ProjenInfo, task?: string) => {
        if (!projenInfo) {
          projenInfo = await quickPickProject();
        }

        if (task) {
          if (useTerminal()) {
            newOrActiveTerminal(projenInfo).sendText(`npx projen ${task}`);
          } else {
            void vscode.tasks.executeTask(
              getVSCodeTask(projenInfo, task, task)
            );
          }
        } else {
          const selection = await vscode.window.showQuickPick(
            projenInfo.tasks.map((t) => t.name)
          );

          if (selection) {
            if (useTerminal()) {
              newOrActiveTerminal(projenInfo).sendText(
                `npx projen ${selection}`
              );
            } else {
              void vscode.tasks.executeTask(
                getVSCodeTask(projenInfo, selection, selection)
              );
            }
          }
        }
      }
    )
  );

  const updateStuff = (projenInfo: ProjenInfo) => {
    void projenInfo.update().then(() => {
      overview._onDidChangeTreeData.fire();
    });
  };

  const projenWatchers = projects.map((p) => new ProjenWatcher(p));
  projenWatchers.forEach((w) =>
    w.onDirectoryChange(() => updateStuff(w.projenInfo))
  );

  for (const p of projects) {
    await p.update();
  }

  overview._onDidChangeTreeData.fire();
}

// this method is called when your extension is deactivated
export function deactivate() {}

function getCDCommand(cwd: vscode.Uri): string {
  if (process && global.process.platform === "win32") {
    if (vscode.env.shell !== "cmd.exe") {
      return `cd "${cwd.fsPath.replace(/\\/g, "/")}"`;
    }
  }

  return `cd "${cwd}"`;
}

async function findProjectInFolder(workspaceFolder?: vscode.WorkspaceFolder) {
  if (!workspaceFolder) {
    return [];
  }
  const exclusions: string[] = ["**/node_modules", "**/cdk.out", "**/dist"];
  const pattern: string = "**/.projen/tasks.json";
  const depFileList = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceFolder, pattern),
    `{${exclusions.join(",")}}`
  );

  const cleanupList = depFileList.map((f) => {
    return f.with({ path: f.path.replace("/.projen/tasks.json", "") });
  });

  return cleanupList;
}
