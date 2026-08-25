const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const packageJson = require(path.join(projectRoot, "package.json"));
const releaseDir = path.join(projectRoot, "release");
const appName = "Skill 拆解器.app";
const sourceApp = path.join(releaseDir, "mac-arm64", appName);
const artifactName = `Skill 拆解器-${packageJson.version}-arm64-testing.zip`;
const artifactPath = path.join(releaseDir, artifactName);

if (!fs.existsSync(sourceApp)) {
  throw new Error(`找不到待封装的应用：${sourceApp}`);
}

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "inherit", ...options });
const removeFinderInfo = (appPath) => run("xattr", ["-rd", "com.apple.FinderInfo", appPath]);
const verify = (appPath) => run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-explorer-testing-"));
const verificationDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-explorer-verify-"));

try {
  const stagedApp = path.join(stagingDir, appName);
  // macOS app bundles contain framework symlinks. `ditto` preserves that
  // structure while excluding desktop/file-provider extended attributes.
  run("ditto", ["--noextattr", "--norsrc", sourceApp, stagedApp]);
  removeFinderInfo(stagedApp);
  run("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", stagedApp]);
  removeFinderInfo(stagedApp);
  verify(stagedApp);

  if (fs.existsSync(artifactPath)) {
    throw new Error(`为避免覆盖已有内测包，已停止构建：${artifactPath}`);
  }
  run("zip", ["-qry", "-X", artifactPath, appName], { cwd: stagingDir });

  run("unzip", ["-q", artifactPath, "-d", verificationDir]);
  verify(path.join(verificationDir, appName));

  const checksum = crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
  fs.writeFileSync(path.join(releaseDir, `${artifactName}.sha256`), `${checksum}  ${artifactName}\n`, "utf8");
  fs.writeFileSync(
    path.join(releaseDir, "内测安装说明.txt"),
    [
      "Skill 拆解器 内测版安装说明",
      "",
      "适用设备：仅支持 Apple 芯片 Mac（M1、M2、M3、M4 等）。",
      "",
      "安装步骤：",
      "1. 双击 ZIP 解压，将“Skill 拆解器”拖到“应用程序”文件夹。",
      "2. 从“应用程序”打开 Finder，按住 Control 点击“Skill 拆解器”，选择“打开”。",
      "3. 在 macOS 确认框中再次选择“打开”。",
      "",
      "这是未公证的朋友内测版：macOS 不能验证发布者，但压缩包已在解压回读后通过完整性封签校验。",
      "请只从发布者提供的链接下载；不要在终端中执行任何关闭系统安全检查的命令。",
      "",
      `ZIP SHA-256：${checksum}`,
    ].join("\n") + "\n",
    "utf8",
  );
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.rmSync(verificationDir, { recursive: true, force: true });
}
