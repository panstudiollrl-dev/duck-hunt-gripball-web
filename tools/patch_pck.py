#!/usr/bin/env python3
"""
把 repo 根目錄的來源檔打包回 index.pck，並同步 index.html 的 fileSizes。

目前會替換三個資源：
    gripball_webhid.js       → res://web/gripball_webhid.js
    duck.gd.reference        → res://scenes/duck.gd
    gripball_input.gd.reference → res://scenes/gripball_input.gd

用法：
    python tools/patch_pck.py

流程：
    1. 讀取上面每一個來源檔（缺檔就跳過該項，不會失敗）
    2. 取代 index.pck 內對應的資源
    3. 重算該檔的 offset / size / md5，並重排後續檔案
    4. 更新 index.html 裡 GODOT_CONFIG.fileSizes["index.pck"]
    5. 驗證：重新解析新 pck，逐檔比對「沒被替換的檔案」是否 byte-for-byte 一致

備註：Godot 4 執行時不會驗證 pck 內各檔的 md5，但這裡還是照規格重算，
      免得之後有工具去檢查。
"""

import hashlib
import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PCK = ROOT / "index.pck"
HTML = ROOT / "index.html"
# 來源檔 → pck 內資源路徑。.gd 檔在 repo root 都加 .reference 後綴，
# 免得 Godot 專案或編輯器把 root 的 .gd 誤認成專案檔。
REPLACEMENTS = {
    "gripball_webhid.js": "res://web/gripball_webhid.js",
    "duck.gd.reference": "res://scenes/duck.gd",
    "gripball_input.gd.reference": "res://scenes/gripball_input.gd",
}
ALIGN = 16

MAGIC = b"GDPC"


def align_up(value, alignment=ALIGN):
    remainder = value % alignment
    return value if remainder == 0 else value + (alignment - remainder)


def parse(data):
    if data[:4] != MAGIC:
        raise SystemExit("index.pck 不是 GDPC 格式")
    pos = 4
    fmt, = struct.unpack_from("<I", data, pos)
    pos += 4
    version = struct.unpack_from("<III", data, pos)
    pos += 12
    if fmt < 2:
        raise SystemExit(f"只支援 pck format >= 2，這個檔是 {fmt}")
    pack_flags, = struct.unpack_from("<I", data, pos)
    pos += 4
    file_base, = struct.unpack_from("<Q", data, pos)
    pos += 8
    pos += 64  # 16 * u32 reserved
    count, = struct.unpack_from("<I", data, pos)
    pos += 4

    entries = []
    for _ in range(count):
        path_len, = struct.unpack_from("<I", data, pos)
        pos += 4
        raw_path = data[pos:pos + path_len]
        pos += path_len
        offset, size = struct.unpack_from("<QQ", data, pos)
        pos += 16
        md5 = data[pos:pos + 16]
        pos += 16
        flags, = struct.unpack_from("<I", data, pos)
        pos += 4
        entries.append({
            "raw_path": raw_path,
            "path": raw_path.rstrip(b"\0").decode("utf-8"),
            "offset": offset,
            "size": size,
            "md5": md5,
            "flags": flags,
            "content": data[file_base + offset: file_base + offset + size],
        })

    return {
        "fmt": fmt,
        "version": version,
        "pack_flags": pack_flags,
        "file_base": file_base,
        "dir_end": pos,
        "entries": entries,
    }


def build(pck, data):
    entries = pck["entries"]
    header = bytearray(data[:pck["dir_end"]])

    # 目錄長度不變（路徑沒動），所以 file_base 可以沿用
    file_base = pck["file_base"]
    if file_base < len(header):
        raise SystemExit("file_base 落在目錄內，格式異常")

    # 依原本的 offset 順序重新排版，維持 16 bytes 對齊
    ordered = sorted(entries, key=lambda e: e["offset"])
    blob = bytearray()
    cursor = 0
    for entry in ordered:
        entry["offset"] = cursor
        entry["size"] = len(entry["content"])
        entry["md5"] = hashlib.md5(entry["content"]).digest()
        blob += entry["content"]
        padded = align_up(cursor + entry["size"])
        blob += b"\0" * (padded - (cursor + entry["size"]))
        cursor = padded

    # 用新的 offset / size / md5 覆寫目錄區
    pos = pck["dir_end"] - sum(
        4 + len(e["raw_path"]) + 16 + 16 + 4 for e in entries
    )
    for entry in entries:
        pos += 4 + len(entry["raw_path"])
        struct.pack_into("<QQ", header, pos, entry["offset"], entry["size"])
        pos += 16
        header[pos:pos + 16] = entry["md5"]
        pos += 16
        pos += 4

    out = bytearray(header)
    out += b"\0" * (file_base - len(header))
    out += blob
    return bytes(out)


def verify(new_bytes, original_entries, expected):
    """expected: {pck 內路徑: 應該有的 bytes}。其餘檔案必須與原本完全相同。"""
    fresh = parse(new_bytes)
    before = {e["path"]: e["content"] for e in original_entries}
    after = {e["path"]: e["content"] for e in fresh["entries"]}

    if before.keys() != after.keys():
        raise SystemExit("驗證失敗：檔案清單不一致")

    untouched = 0
    for path, content in after.items():
        if path in expected:
            if content != expected[path]:
                raise SystemExit(f"驗證失敗：{path} 內容不是預期的新版本")
        else:
            if content != before[path]:
                raise SystemExit(f"驗證失敗：{path} 不該被動到，但內容變了")
            untouched += 1

    for entry in fresh["entries"]:
        if hashlib.md5(entry["content"]).digest() != entry["md5"]:
            raise SystemExit(f"驗證失敗：{entry['path']} md5 不符")

    return len(fresh["entries"]), untouched


def update_html(new_size):
    text = HTML.read_text(encoding="utf-8")
    match = re.search(r"const GODOT_CONFIG = (\{.*?\});", text, re.S)
    if not match:
        raise SystemExit("在 index.html 找不到 GODOT_CONFIG")

    config = json.loads(match.group(1))
    old_size = config.get("fileSizes", {}).get("index.pck")
    if old_size == new_size:
        return old_size, new_size, False

    config["fileSizes"]["index.pck"] = new_size
    replacement = "const GODOT_CONFIG = " + json.dumps(
        config, separators=(",", ":"), ensure_ascii=False
    ) + ";"
    HTML.write_text(
        text[:match.start()] + replacement + text[match.end():], encoding="utf-8"
    )
    return old_size, new_size, True


def main():
    data = PCK.read_bytes()
    pck = parse(data)
    originals = [dict(e) for e in pck["entries"]]
    by_path = {e["path"]: e for e in pck["entries"]}

    expected = {}
    changes = []
    for source_name, target_path in REPLACEMENTS.items():
        source = ROOT / source_name
        if not source.exists():
            print(f"跳過 {source_name}（檔案不存在）")
            continue
        entry = by_path.get(target_path)
        if entry is None:
            raise SystemExit(f"pck 內找不到 {target_path}")

        content = source.read_bytes()
        expected[target_path] = content
        if entry["content"] == content:
            print(f"{target_path} 已經是最新的")
            continue
        changes.append(f"{target_path}：{entry['size']} → {len(content)} bytes")
        entry["content"] = content

    if not changes:
        print("index.pck 內容已經是最新的，不需要更動。")
        return

    for line in changes:
        print("更新 " + line)

    new_bytes = build(pck, data)
    checked, untouched = verify(new_bytes, originals, expected)

    PCK.write_bytes(new_bytes)
    old_size, new_size, changed = update_html(len(new_bytes))

    print(f"驗證通過：{checked} 個檔案，其中 {untouched} 個 byte-for-byte 未變動")
    print(f"index.pck: {len(data)} → {len(new_bytes)} bytes")
    if changed:
        print(f"index.html fileSizes: {old_size} → {new_size}")
    else:
        print("index.html fileSizes 不需更動")
    print("\n完成。記得 commit index.pck、index.html 和 gripball_webhid.js。")


if __name__ == "__main__":
    main()
