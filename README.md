# IMPERIAL RADIO (Fastify + TypeScript)

Минимальное веб‑приложение для онлайн‑радио: сайт с плеером, прокси аудио‑потока, “Сейчас играет”, админ‑загрузка. Интерфейс RU, тёмная тема.

## Установка
```
npm i
copy .env.example .env
npm run build
npm start
```

## Проверка
```
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/nowplaying
```

## Эндпоинты
- `GET /` — публичная страница (плеер)
- `GET /stream` — проксированный поток Icecast
- `GET /api/nowplaying` — JSON с текущим треком
- `GET /api/health` — health
- `GET /admin` — админка (Basic Auth)
- `POST /api/admin/upload/music`
- `POST /api/admin/upload/jingle`

## Пример Nginx
```
server {
  listen 443 ssl;
  server_name example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
  }

  location /stream {
    proxy_pass http://127.0.0.1:3000/stream;
    proxy_buffering off;
    proxy_read_timeout 1h;
  }
}
```

## Пример systemd unit
```
[Unit]
Description=IMPERIAL RADIO Web
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/imperial-radio
ExecStart=/usr/bin/node /path/to/imperial-radio/dist/server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## Примечания
- `/api/nowplaying` использует in‑memory кэш с TTL `NOWPLAYING_CACHE_MS`.
- `/admin` закрыт, если `ADMIN_USER` или `ADMIN_PASS` пустые (fail‑closed).
- Логирование по умолчанию `LOG_LEVEL=silent`.

## Политика контента и прав

Ниже - политика для легального использования контента.

### Использование контента
- В эфире размещается только контент, на который у администрации станции есть права, лицензии или письменные разрешения правообладателей.
- Если права отсутствуют, контент не должен размещаться в эфире.
- Ответственность за соблюдение лицензий несёт владелец станции.

### Правообладателям (Notice & Takedown)
Если вы являетесь правообладателем и считаете, что ваш контент используется без разрешения:
- отправьте обращение с указанием трека, доказательством прав и способом связи;
- мы рассмотрим обращение и, при необходимости, удалим контент.

### Контакты
Контакт для обращений: `kirk@kirkawa.ru`
