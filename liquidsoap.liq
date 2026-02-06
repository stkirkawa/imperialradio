# Minimal AutoDJ for Imperial Radio (FFmpeg encoder)
# Requires: ffmpeg in PATH

# Control server (telnet)
set("server.telnet", true)
set("server.telnet.bind_addr", "127.0.0.1")
set("server.telnet.port", 1234)

# Music library
music = playlist(id="music", mode="random", reload=10, reload_mode="seconds", "C:/radio/music")

# Jingles library (optional)
jingles = playlist(id="jingles", mode="random", reload=30, reload_mode="seconds", "C:/radio/jingles")

# Make sources safe (avoid fallible error when dirs are empty)
music = mksafe(music)
jingles = mksafe(jingles)

# Request queues (for admin actions)
queue_next = request.queue(id="next", interactive=true)
queue_main = request.queue(id="queue", interactive=true)

# Mix: 8 tracks music then 1 jingle on average
radio_main = rotate(weights=[8,1], [music, jingles])
radio = fallback(track_sensitive=false, [queue_next, queue_main, radio_main])

# Ensure each track has a title (fallback to filename)
def ensure_title(m) =
  f =
    if list.assoc.mem("filename", m) then
      list.assoc("filename", m)
    else if list.assoc.mem("uri", m) then
      list.assoc("uri", m)
    else
      ""
    end
  end
  if f == "" then
    m
  else
    base = path.basename(f)
    base = path.remove_extension(base)
    base = string.replace(pattern="^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z_", (fun (_) -> ""), base)
    base = string.replace(pattern="_+", (fun (_) -> " "), base)
    base = string.trim(base)
    if list.assoc.mem("title", m) then
      t = list.assoc("title", m)
      if string.trim(t) != "" then
        m
      else
        m = list.assoc.remove("title", m)
        [("title", base), ...m]
      end
    else
      [("title", base), ...m]
    end
  end
end

radio = metadata.map(insert_missing=true, ensure_title, radio)

# Ensure non-empty content type and audio format
radio = fallback(track_sensitive=false, [radio, sine()])
radio = stereo(radio)

# Icecast output (MP3 via ffmpeg)
output.icecast(
  %ffmpeg(format="mp3", %audio(codec="libmp3lame", b="192k")),
  host="127.0.0.1",
  port=8000,
  user="source",
  password="skollirmq",
  mount="/radio.mp3",
  name="IMPERIAL RADIO",
  description="AutoDJ",
  radio
)
