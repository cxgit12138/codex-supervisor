"""打包、验证并切换 Supervisor 的运行文件。只用 Python 标准库。"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
from datetime import datetime, timezone
from uuid import uuid4
from zipfile import ZipFile, ZIP_DEFLATED

ASSET = "codex-supervisor.zip"
INFO = "install-info.json"
FILES = {"plugin.json", "hooks.json", "mcp_config.json", "LICENSE", "assets/logo.svg"}
FOLDERS = {"hooks", "lib", "sidecars", "skills", "mcp"}
REQUIRED = FILES | {INFO, "hooks/codex-hook.mjs", "skills/codex-supervisor/SKILL.md",
                    "skills/codex-supervisor/scripts/bridge-daemon.mjs",
                    "skills/codex-supervisor/scripts/codex-ctl.mjs",
                    "sidecars/codex_panel/sidecar.json", "sidecars/codex_panel/main.mjs",
                    "sidecars/codex_panel/server.mjs", "sidecars/codex_panel/app.js", "sidecars/codex_panel/index.html",
                    "sidecars/codex_panel/styles.css", "sidecars/codex_panel/settings.js",
                    "mcp/server.mjs", "mcp/view.js", "lib/release.py", "lib/preferences.mjs",
                    "lib/projects.mjs", "lib/usage.mjs", "lib/update.mjs"}
VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?(?:\+([\w.-]+))?", re.ASCII)


def complete(archive):
    return REQUIRED.issubset(archive.namelist()) and any(
        name.startswith("mcp/vendor/ext-apps-") and name.endswith(".js.gz") for name in archive.namelist())


def manifest_at(root):
    return json.loads((root / "plugin.json").read_bytes())


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def runtime_file(name):
    parts = name.split("/")
    return (name in FILES or name == INFO or
            (parts[0] in FOLDERS and len(parts) > 1 and
             all(re.fullmatch(r"[a-zA-Z0-9_-][a-zA-Z0-9_.-]*", part) and not part.endswith(".")
                 for part in parts) and "__pycache__" not in parts and "node_modules" not in parts
             and PurePosixPath(name).suffix in {".json", ".mjs", ".js", ".md", ".html", ".css", ".py", ".gz", ".LICENSE"}))


def pack(root, destination, commit, tag):
    version = manifest_at(root)["version"]
    if not VERSION.fullmatch(version) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("版本号或提交号无效")
    if tag not in ("latest", "v" + version):
        raise ValueError("发布标签与 plugin.json 版本不一致")
    destination.mkdir(parents=True, exist_ok=True)
    built = datetime.now(timezone.utc).isoformat()
    info = dict(version=version, commitSha=commit, releaseTag=tag, builtAt=built)
    names = set(FILES)
    for folder in FOLDERS:
        names.update(p.relative_to(root).as_posix() for p in (root / folder).rglob("*") if p.is_file())
    with ZipFile(destination / ASSET, "w", ZIP_DEFLATED) as archive:
        for name in sorted(n for n in names if runtime_file(n)):
            archive.write(root / name, name)
        archive.writestr(INFO, json.dumps(info))
        if not complete(archive):
            raise ValueError("运行文件不完整")
    manifest = dict(**info, assetName=ASSET, sha256=digest(destination / ASSET))
    (destination / "release-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def stage_package(archive_path, manifest, stage):
    if manifest["assetName"] != ASSET or digest(archive_path) != manifest["sha256"]:
        raise ValueError("更新包 SHA256 校验失败")
    seen = set()
    with ZipFile(archive_path) as archive:
        for entry in archive.infolist():
            name = entry.filename
            if not runtime_file(name) or name.casefold() in seen or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError("更新包包含无效路径")
            seen.add(name.casefold())
            dest = stage / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as src, dest.open("xb") as output:
                shutil.copyfileobj(src, output)
        if not complete(archive):
            raise ValueError("更新包缺少运行文件")
    plugin = manifest_at(stage)
    info = json.loads((stage / INFO).read_bytes())
    if plugin["name"] != "codex-supervisor" or plugin["version"] != manifest["version"] or any(
            info[k] != manifest[k] for k in ("version", "commitSha", "releaseTag", "builtAt")):
        raise ValueError("包内插件清单与发布信息不一致")


def activate(root, stage, data_dir):
    root = root.absolute()
    if ".." in root.parts:
        raise ValueError("安装目录无效")
    for directory in (root, *root.parents):
        entry = directory.lstat()
        if stat.S_ISLNK(entry.st_mode) or (os.name == "nt" and entry.st_reparse_tag == stat.IO_REPARSE_TAG_MOUNT_POINT):
            raise ValueError("安装目录无效")
    if manifest_at(root)["name"] != "codex-supervisor":
        raise ValueError("安装目录无效")
    backup = data_dir / "backups" / str(uuid4())
    backup.parent.mkdir(exist_ok=True)
    os.rename(root, backup)
    try:
        os.rename(stage, root)
    except OSError:
        os.rename(backup, root)
        raise
    return backup


if __name__ == "__main__":
    action, *args = sys.argv[1:]
    if action == "pack":
        pack(Path(args[0]), Path(args[1]), args[2], args[3])
    elif action == "stage":
        stage_package(Path(args[0]), json.loads(Path(args[1]).read_bytes()), Path(args[2]))
    elif action == "activate":
        print(activate(*map(Path, args)))
    else:
        sys.exit("未知操作")
