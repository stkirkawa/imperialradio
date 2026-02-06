$files = @('public\index.html','src\routes\public.routes.ts')
foreach ($f in $files) {
  $p = Join-Path 'C:\Users\ladin\OneDrive\Desktop\radio' $f
  $txt = Get-Content -Raw $p
  $txt = $txt -replace '\\n', "`n"
  $txt = $txt -replace 'let isPlaying = false;\s*let lastVolume', "let isPlaying = false;`n    let lastVolume"
  Set-Content -Encoding utf8 $p $txt
}
