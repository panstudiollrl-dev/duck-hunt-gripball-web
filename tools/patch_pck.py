#!/usr/bin/env python3
"""
把 repo 根目錄的 gripball_webhid.js 打包回 index.pck，並同步 index.html 的 fileSizes。

用法：
    python tools/patch_pck.py

流程：
    1. 讀取 gripball_webhid.js
    2. 取代 index.pck 內的 res://web/gripball_webhid.js
    3. 重算該檔的 offset / size / md5，並重排後續檔案
    4. 更新 index.html 裡 GODOT_CONFIG.fileSizes["index.pck"]
    5. 驗證：重新解析新 pck，逐檔比對其餘 101 個檔案是否完全一致

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
SOURCE = ROOT / "gripball_webhid.js"
TARGET = "res://web/gripball_webhid.js"
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


def verify(new_bytes, original_entries, expected_js):
    fresh = parse(new_bytes)
    before = {e["path"]: e["content"] for e in original_entries}
    after = {e["path"]: e["content"] for e in fresh["entries"]}

    if before.keys() != after.keys():
        raise SystemExit("驗證失敗：檔案清單不一致")

    for path, content in after.items():
        expected = expected_js if path == TARGET else before[path]
        if content != expected:
            raise SystemExit(f"驗證失敗：{path} 內容不符")

    for entry in fresh["entries"]:
        if hashlib.md5(entry["content"]).digest() != entry["md5"]:
            raise SystemExit(f"驗證失敗：{entry['path']} md5 不符")

    return len(fresh["entries"])


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
    if not SOURCE.exists():
        raise SystemExit(f"找不到 {SOURCE}")

    js = SOURCE.read_bytes()
    data = PCK.read_bytes()
    pck = parse(data)

    originals = [dict(e) for e in pck["entries"]]
    target = next((e for e in pck["entries"] if e["path"] == TARGET), None)
    if target is None:
        raise SystemExit(f"pck 內找不到 {TARGET}")

    if target["content"] == js:
        print("index.pck 內容已經是最新的，不需要更動。")
        return

    print(f"更新 {TARGET}：{target['size']} → {len(js)} bytes")
    target["content"] = js

    new_bytes = build(pck, data)
    checked = verify(new_bytes, originals, js)

    PCK.write_bytes(new_bytes)
    old_size, new_size, changed = update_html(len(new_bytes))

    print(f"驗證通過：{checked} 個檔案")
    print(f"index.pck: {len(data)} → {len(new_bytes)} bytes")
    if changed:
        print(f"index.html fileSizes: {old_size} → {new_size}")
    else:
        print("index.html fileSizes 不需更動")
    print("\n完成。記得 commit index.pck、index.html 和 gripball_webhid.js 三個檔案。")


if __name__ == "__main__":
    main()
