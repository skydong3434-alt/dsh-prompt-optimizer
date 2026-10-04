#!/usr/bin/env bash
# backup-profile — 正式安装前对 desktop profile 做可恢复备份 / 恢复（P09-T01）。
#
# 用法:
#   bash scripts/backup-profile.sh backup [tag]   # 备份 desktop profile 关键文件 + 插件清单
#   bash scripts/backup-profile.sh restore <backup-dir> [--uninstall-link <pkg>]
#
# 只备份安装本插件会触碰的内容（不整体复制 node_modules，避免备份巨大且 node_modules 可由
# pnpm install 重建）：
#   - 五文件: package.json / cordis.yml / cordis.patch.yml / pnpm-workspace.yaml / pnpm-lock.yaml
#   - 插件清单快照（package.json 的 dependencies + dsh.profile.bundles 序列化）
#   - 当前 git HEAD（repo 侧参照）
# restore 模式: 把五文件还原 + 按需移除插件 link 目录 + 提示 pnpm install 重建依赖。
set -euo pipefail

PROFILE_DIR="${DESKTOP_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
BACKUP_ROOT="${APO_BACKUP_ROOT:-$HOME/.dsh/backups/apo}"
TS="$(date +%Y%m%d-%H%M%S)"

FILES=(package.json cordis.yml cordis.patch.yml pnpm-workspace.yaml pnpm-lock.yaml)

mode="${1:-backup}"
case "$mode" in
  backup)
    tag="${2:-g7-install}"
    out="$BACKUP_ROOT/$tag-$TS"
    mkdir -p "$out"
    for f in "${FILES[@]}"; do
      if [ -f "$PROFILE_DIR/$f" ]; then
        cp -p "$PROFILE_DIR/$f" "$out/$f"
      else
        echo "  [warn] 缺文件记录: $f" >&2
      fi
    done
    # 插件清单快照（无密钥，仅依赖与 bundle 名）
    python3 - "$out" <<'PY'
import json, sys, os
out = sys.argv[1]
p = os.path.join(os.environ.get("PROFILE_DIR",""), "package.json") if False else None
path = os.path.expanduser("~/.dsh/profiles/desktop/package.json")
with open(path, encoding="utf-8") as fh:
    d = json.load(fh)
snap = {
  "dependencies": {k: v for k, v in d.get("dependencies", {}).items()},
  "bundles": d.get("dsh", {}).get("profile", {}).get("bundles", []),
}
with open(os.path.join(out, "plugin-snapshot.json"), "w", encoding="utf-8") as fh:
    json.dump(snap, fh, ensure_ascii=False, indent=2)
print("  plugin-snapshot.json: %d deps / %d bundles" % (len(snap["dependencies"]), len(snap["bundles"])))
PY
    # hash+mtimes 记录
    (
      for f in "${FILES[@]}"; do
        [ -f "$PROFILE_DIR/$f" ] && sha256sum "$PROFILE_DIR/$f" 2>/dev/null || shasum -a 256 "$PROFILE_DIR/$f"
        stat -f "%N | mtime=%Sm" -t "%Y-%m-%dT%H:%M:%S%z" "$PROFILE_DIR/$f"
      done
    ) > "$out/install-before-hashes.txt" 2>/dev/null || true
    # 当前 git HEAD（repo 参照）
    (cd "$(dirname "$0")/.." && git rev-parse HEAD) > "$out/repo-head.txt" 2>/dev/null || true
    echo "备份完成: $out"
    echo "  恢复: bash $0 restore $out"
    ;;
  restore)
    backup_dir="${2:?restore 需要备份目录}"
    [ -f "$backup_dir/package.json" ] || { echo "错误: $backup_dir 不是有效备份（缺 package.json）" >&2; exit 1; }
    echo "将会还原 desktop profile 五文件:"
    for f in "${FILES[@]}"; do
      [ -f "$backup_dir/$f" ] && cp -p "$backup_dir/$f" "$PROFILE_DIR/$f" && echo "  ✓ $f"
    done
    # 按需移除已安装的本地 link 插件目录（可选：--uninstall-link <pkg>）
    if shift 2 && [ "${1:-}" = "--uninstall-link" ]; then
      pkg="${2:?需要包名}"
      rm -rf "$PROFILE_DIR/node_modules/$pkg"
      echo "  已移除 link: $pkg"
    fi
    echo "提示: 在 desktop profile 内执行 pnpm install 重建依赖后重启 DSH Desktop 生效。"
    ;;
  *)
    echo "用法: $0 backup [tag] | $0 restore <dir> [--uninstall-link <pkg>]" >&2
    exit 2;;
esac