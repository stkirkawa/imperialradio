# Imperial Radio AutoDJ: playlists, queued requests, DJ live and microphone mix.
# Compatible with the legacy Liquidsoap 2.x scripting interface used by this project.
# The Liquidsoap service must receive these environment variables, not just Node.js.
# Set LIVE_INGRESS_PASSWORD and ICECAST_SOURCE_PASSWORD to strong independent secrets.

def env_or(name, default_value) =
  value = getenv(name)
  if value == "" then default_value else value end
end

live_ingress_password = getenv("LIVE_INGRESS_PASSWORD")
icecast_source_password = getenv("ICECAST_SOURCE_PASSWORD")
if live_ingress_password == "" or live_ingress_password == "CHANGE_ME_LOCAL_INGRESS_PASSWORD" then
  failwith("Set LIVE_INGRESS_PASSWORD for the Liquidsoap service")
end
if icecast_source_password == "" or icecast_source_password == "CHANGE_ME_ICECAST_SOURCE_PASSWORD" then
  failwith("Set ICECAST_SOURCE_PASSWORD for the Liquidsoap service")
end

# Never expose the unauthenticated control port or the private Harbor inputs.
set("server.telnet", true)
set("server.telnet.bind_addr", "127.0.0.1")
set("server.telnet.port", int_of_string(env_or("LIQUIDSOAP_PORT", "1234")))
set("harbor.bind_addr", "127.0.0.1")

# Music library
music = playlist(id="music", mode="random", reload=10, reload_mode="seconds", env_or("MUSIC_DIR", "/radio/music"))

# Jingles library (optional)
jingles = playlist(id="jingles", mode="random", reload=30, reload_mode="seconds", env_or("JINGLES_DIR", "/radio/jingles"))

# Keep these sources fallible: mksafe(jingles) inserts silence whenever the
# optional jingle folder is empty. A final fallback below keeps output alive.

# Request queues (for admin actions)
queue_next = request.queue(id="next", interactive=true)
queue_main = request.queue(id="queue", interactive=true)
dj_queue = request.queue(id="dj_queue", interactive=true)
dj_connected = ref(false)
dj_mic_connected = ref(false)
dj_mic_enabled = ref(false)
dj_mic_gain = ref(0.0)
music_gain = ref(1.0)
output_gain = ref(1.0)

def rec remove_queue_item(items, position) =
  if position == 0 then
    list.tl(items)
  else
    first = list.hd(items)
    rest = remove_queue_item(list.tl(items), position - 1)
    [first, ...rest]
  end
end

def rec insert_queue_item(items, position, item) =
  if position == 0 then
    [item, ...items]
  else
    first = list.hd(items)
    rest = insert_queue_item(list.tl(items), position - 1, item)
    [first, ...rest]
  end
end

def move_dj_queue(arguments) =
  parts = string.split(separator=" ", arguments)
  if list.length(parts) != 2 then
    "ERROR: expected source and destination positions"
  else
    source_position = int_of_string(list.nth(parts, 0))
    target_position = int_of_string(list.nth(parts, 1))
    items = dj_queue.queue()
    count = list.length(items)
    if source_position < 0 or source_position >= count or target_position < 0 or target_position >= count then
      "ERROR: queue position out of range"
    else
      item = list.nth(items, source_position)
      remaining = remove_queue_item(items, source_position)
      dj_queue.set_queue(insert_queue_item(remaining, target_position, item))
      "Done."
    end
  end
end
server.register(namespace="dj_queue", "move", move_dj_queue)

def remove_dj_queue(arguments) =
  position = int_of_string(arguments)
  items = dj_queue.queue()
  if position < 0 or position >= list.length(items) then
    "ERROR: queue position out of range"
  else
    removed = list.nth(items, position)
    remaining = remove_queue_item(items, position)
    dj_queue.set_queue(remaining)
    request.destroy(removed)
    "Done."
  end
end
server.register(namespace="dj_queue", "remove", remove_dj_queue)

def set_output_volume(arguments) =
  percent = int_of_string(arguments)
  if percent < 0 or percent > 100 then
    "ERROR: volume out of range"
  else
    output_gain := float_of_int(percent) / 100.0
    "Done."
  end
end
server.register(namespace="imperial_radio", "volume", set_output_volume)

def set_microphone_enabled(arguments) =
  if arguments == "on" then
    dj_mic_enabled := true
    dj_mic_gain := 1.0
    music_gain := 0.72
    "Done."
  else if arguments == "off" then
    dj_mic_enabled := false
    dj_mic_gain := 0.0
    music_gain := 1.0
    "Done."
  else
    "ERROR: expected on or off"
  end
  end
end
server.register(namespace="imperial_radio", "mic", set_microphone_enabled)

dj_live = input.harbor(
  "/dj-live",
  id="dj_live",
  port=8005,
  on_connect=fun (_) -> dj_connected := true,
  on_disconnect=fun () -> dj_connected := false,
  password=live_ingress_password
)

dj_mic = input.harbor(
  "/dj-mic",
  id="dj_mic",
  port=8005,
  on_connect=fun (_) -> dj_mic_connected := true,
  on_disconnect=fun () -> dj_mic_connected := false,
  password=live_ingress_password
)
# Mix: 8 tracks music then 1 jingle on average (when jingles are present)
radio_main = rotate(weights=[8,1], [music, jingles])
radio_queue = audio_to_stereo(fallback(track_sensitive=false, [dj_queue, queue_next, queue_main, radio_main]))
dj_live_audio = audio_to_stereo(dj_live)
radio = switch(track_sensitive=false, [
  ({!dj_connected}, dj_live_audio),
  ({true}, radio_queue)
])
dj_mic_audio = switch(track_sensitive=false, [
  ({!dj_mic_connected}, audio_to_stereo(dj_mic)),
  ({true}, blank())
])
radio = add(normalize=false, [
  amplify({!music_gain}, radio),
  amplify({!dj_mic_gain}, dj_mic_audio)
])
radio = amplify({!output_gain}, radio)

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

radio = map_metadata(insert_missing=true, ensure_title, radio)

# Ensure non-empty content type and audio format
radio = fallback(track_sensitive=false, [radio, sine()])
radio = audio_to_stereo(radio)

# Icecast output (MP3)
output.icecast(
  %mp3(bitrate=128),
  host="127.0.0.1",
  port=8000,
  user="source",
  password=icecast_source_password,
  mount="/radio.mp3",
  name="IMPERIAL RADIO",
  description="AutoDJ",
  radio
)
