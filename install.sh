#!/usr/bin/env bash
set -euo pipefail

# Local installer. No downloads, no config edits, no existing directory overwrites.
relay_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
st_root="${1:-$HOME/SillyTavern}"
st_handle="${2:-}"
if [[ ! -f "$st_root/server.js" || ! -f "$st_root/config.yaml" ]]; then
    echo "실리태번 폴더가 아닙니다. 사용법: bash install.sh 실리태번폴더 [사용자핸들]" >&2
    exit 1
fi
st_root="$(cd -- "$st_root" && pwd)"
if [[ -z "$st_handle" ]]; then
    candidates=()
    for candidate in "$st_root"/data/*; do
        [[ -d "$candidate/chats" && -d "$candidate/extensions" ]] && candidates+=("$candidate")
    done
    if [[ ${#candidates[@]} -ne 1 ]]; then
        echo "사용자 폴더를 자동으로 고르지 못했습니다. 두 번째 인자로 사용자 핸들을 지정해 주세요." >&2
        echo "예: bash install.sh ~/SillyTavern default-user" >&2
        exit 1
    fi
    st_handle="$(basename -- "${candidates[0]}")"
fi
if [[ ! "$st_handle" =~ ^[a-zA-Z0-9_-]+$ || ! -d "$st_root/data/$st_handle/extensions" ]]; then
    echo "사용자 핸들 또는 extensions 폴더를 확인해 주세요." >&2
    exit 1
fi
plugin_dest="$st_root/plugins/Silly-Relay"
extension_dest="$st_root/data/$st_handle/extensions/Silly-Relay"
if [[ -e "$plugin_dest" || -L "$plugin_dest" || -e "$extension_dest" || -L "$extension_dest" ]]; then
    echo "Silly-Relay 폴더가 이미 있습니다. 기존 파일을 덮어쓰지 않고 중단합니다." >&2
    exit 1
fi
mkdir -p -- "$st_root/plugins"
mkdir -- "$plugin_dest" "$extension_dest"
cp -- "$relay_source/package.json" "$relay_source/LICENSE" "$plugin_dest/"
cp -R -- "$relay_source/server" "$plugin_dest/server"
for relay_file in manifest.json index.js transport.mjs recovery.mjs identity.mjs reply-filter.mjs reply-session.mjs style.css LICENSE; do
    cp -- "$relay_source/$relay_file" "$extension_dest/"
done
echo "Silly Relay 서버 1.0.2 / 웹 확장 1.0.8 설치 완료"
echo "config.yaml의 enableServerPlugins: true를 확인하고 서버를 완전히 재시작해 주세요."
echo "실리를 새로고침한 뒤 확장 설정 → Silly Relay → 연결 확인 → 연결 유지을 켜세요."

