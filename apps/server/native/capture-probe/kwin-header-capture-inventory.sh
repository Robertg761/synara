#!/usr/bin/env bash
# Demonstrates the installed KWin in-compositor capture surface by inventorying
# headers and the built-in screenshot plugin. It performs no compositor action.

set -u

header_root='/usr/include/kwin'
screenshot_plugin='/usr/lib64/qt6/plugins/kwin/plugins/screenshot.so'

printf '%s\n' '== KWin in-compositor capture header inventory =='
if command -v rpm >/dev/null 2>&1; then
  rpm -q kwin kwin-devel kwin-libs 2>&1
fi

printf '%s\n' '--- render and scene declarations ---'
for file in \
  "$header_root/core/rendertarget.h" \
  "$header_root/opengl/gltexture.h" \
  "$header_root/opengl/glframebuffer.h" \
  "$header_root/scene/itemrenderer.h" \
  "$header_root/scene/scene.h" \
  "$header_root/scene/item.h" \
  "$header_root/scene/windowitem.h" \
  "$header_root/scene/surfaceitem.h" \
  "$header_root/effect/offscreeneffect.h"; do
  if [ -r "$file" ]; then
    printf '%s\n' "file=$file"
    rg -n 'class KWIN_EXPORT|RenderTarget\(|GLFramebuffer\(|toImage|blitFromRenderTarget|beginFrame|renderItem|SceneView\(|ItemTreeView\(|addWindowFilter|GraphicsBuffer|buffer\(|texture\(|offscreen texture|paint\(' "$file" 2>&1 || true
  else
    printf 'missing=%s\n' "$file"
  fi
done

printf '%s\n' '--- built-in screenshot implementation symbols ---'
if [ -r "$screenshot_plugin" ] && command -v nm >/dev/null 2>&1; then
  nm -D -C "$screenshot_plugin" 2>&1 \
    | rg 'SceneView|OutputLayer|RenderTarget|GLFramebuffer|EglContext|glRead|QImage|excludeFromCapture' \
    | head -n 80 || true
else
  printf 'plugin not readable or nm unavailable: %s\n' "$screenshot_plugin"
fi

printf '%s\n' '--- verdict to carry into design ---'
printf '%s\n' 'The headers expose scene filtering, offscreen render targets, GL readback, and client buffers.'
printf '%s\n' 'They do not expose a stable plugin-level capture-to-PipeWire helper; transport remains implementation work.'
