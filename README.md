# AirRadar MVP — Cloudflare edition

AirRadar — браузерная live-карта самолётов на открытых ADS-B данных **ADSB.lol**.

Эта версия не требует Python, Node.js, Git или постоянно включённого компьютера. После публикации приложение работает на Cloudflare Workers и открывается по обычной HTTPS-ссылке вида:

```text
https://airradar-mvp.<ваш-workers-subdomain>.workers.dev
```

## Что уже работает

- live-карта самолётов вокруг центра карты;
- автообновление каждые 5 секунд, пока вкладка активна;
- поиск по callsign, регистрации и ICAO HEX;
- карточка борта: регистрация, тип, оператор, высота, скорость, курс, vertical rate, squawk;
- emergency-индикация для 7500 / 7600 / 7700 и emergency flag;
- фильтры «в воздухе», military и emergency;
- фильтр по минимальной высоте;
- локальный трек выбранного борта в рамках текущей вкладки;
- кнопка геопозиции;
- backend-proxy внутри Cloudflare Worker;
- короткое edge-кэширование upstream-запросов, чтобы не дублировать обращения к ADSB.lol;
- автоматическое обновление сайта после будущих изменений в GitHub.

---

# Самый простой способ публикации — без установки программ

Нужны только:

1. браузер;
2. аккаунт GitHub;
3. аккаунт Cloudflare.

Ни Python, ни Node.js, ни Git на компьютере устанавливать не нужно.

## Шаг 1. Распаковать архив

Распакуйте ZIP с проектом в обычную папку.

В корне должны быть видны:

```text
README.md
wrangler.jsonc
LICENSE-NOTICE.txt
src/
public/
```

В `src` должен лежать:

```text
worker.js
```

В `public`:

```text
index.html
app.js
app.css
```

Важно: при загрузке на GitHub именно `wrangler.jsonc`, `src` и `public` должны оказаться **в корне репозитория**, а не внутри дополнительной папки `airradar-cloudflare`.

---

# Шаг 2. Создать репозиторий GitHub

1. Откройте https://github.com/
2. Войдите в аккаунт.
3. Нажмите **New repository**.
4. В поле Repository name укажите:

```text
airradar-mvp
```

5. Репозиторий может быть **Private** или **Public**. Для работы Cloudflare подходит оба варианта, если дать Cloudflare доступ к выбранному репозиторию.
6. README, `.gitignore` и License на странице создания добавлять не нужно — они уже есть в проекте.
7. Нажмите **Create repository**.

---

# Шаг 3. Загрузить файлы в GitHub через браузер

На странице пустого репозитория:

1. Нажмите **uploading an existing file** или **Add file → Upload files**.
2. Откройте распакованную папку AirRadar на компьютере.
3. Выделите всё содержимое папки и перетащите в окно GitHub:

```text
README.md
wrangler.jsonc
LICENSE-NOTICE.txt
src
public
```

Можно перетаскивать и папки — GitHub сохранит структуру.

4. В поле commit message можно написать:

```text
Initial AirRadar Cloudflare MVP
```

5. Нажмите **Commit changes**.

После загрузки структура репозитория должна выглядеть так:

```text
airradar-mvp/
├── README.md
├── wrangler.jsonc
├── LICENSE-NOTICE.txt
├── src/
│   └── worker.js
└── public/
    ├── index.html
    ├── app.js
    └── app.css
```

Если вы видите `airradar-cloudflare/wrangler.jsonc`, то есть появилась лишняя внешняя папка, Cloudflare не найдёт конфигурацию в корне. В таком случае перенесите содержимое на один уровень выше.

---

# Шаг 4. Создать аккаунт Cloudflare

1. Откройте https://dash.cloudflare.com/
2. Создайте аккаунт или войдите.
3. Добавлять собственный домен пока не нужно.

Cloudflare автоматически выдаст бесплатный адрес `workers.dev`.

---

# Шаг 5. Подключить GitHub к Cloudflare

В Cloudflare Dashboard:

1. Откройте **Workers & Pages**.
2. Нажмите **Create application**.
3. В блоке **Import a repository** нажмите **Get started**.
4. Выберите **GitHub**.
5. Если Cloudflare запросит разрешение GitHub, разрешите доступ к репозиторию `airradar-mvp`.
6. Выберите репозиторий:

```text
airradar-mvp
```

---

# Шаг 6. Настройки сборки

Cloudflare должен увидеть `wrangler.jsonc` автоматически.

Проверьте следующие параметры.

## Project / Worker name

Должно быть:

```text
airradar-mvp
```

Это важно: имя Worker в Cloudflare должно совпадать с полем `name` внутри `wrangler.jsonc`.

## Production branch

```text
main
```

## Root directory

Оставить корень репозитория:

```text
/
```

или пустое значение, если интерфейс Cloudflare использует пустое поле для корня.

## Build command

Оставить **пустым**.

Никакой сборки React/Vite здесь нет — проект состоит из обычного HTML/CSS/JS.

## Deploy command

Если Cloudflare заполняет его автоматически, оставьте значение по умолчанию:

```text
npx wrangler deploy
```

Если поле пустое и Cloudflare просит его заполнить — укажите эту команду вручную.

После этого нажмите:

**Save and Deploy** / **Deploy**.

---

# Шаг 7. Первый запуск

После успешного deployment Cloudflare покажет адрес примерно такого вида:

```text
https://airradar-mvp.<ваш-subdomain>.workers.dev
```

Откройте его.

На экране должны появиться:

- тёмная карта;
- маркеры самолётов;
- количество бортов;
- строка времени обновления;
- поиск;
- фильтры.

Первоначальный центр карты — Москва.

---

# Шаг 8. Быстрая проверка backend

К адресу сайта добавьте:

```text
/api/health
```

Например:

```text
https://airradar-mvp.example.workers.dev/api/health
```

Должен появиться JSON примерно такого вида:

```json
{
  "ok": true,
  "service": "AirRadar MVP",
  "upstream": "https://api.adsb.lol"
}
```

Это означает, что сам Cloudflare Worker запущен.

Для проверки live-данных можно открыть:

```text
/api/aircraft?lat=55.75124&lon=37.61842&radius=100
```

Если ADSB.lol доступен и в выбранном районе есть принимаемые борта, вы получите JSON со списком `ac`.

---

# Как теперь будут работать обновления проекта

После подключения GitHub Cloudflare включает автоматические deployments.

Логика следующая:

```text
изменили файл в GitHub
        ↓
Commit changes
        ↓
Cloudflare замечает новый commit
        ↓
автоматический deploy
        ↓
та же workers.dev ссылка уже показывает новую версию
```

То есть в дальнейшем достаточно менять файлы прямо через GitHub в браузере.

## Как изменить файл через GitHub без Git

1. Откройте репозиторий.
2. Откройте нужный файл, например `public/app.js`.
3. Нажмите иконку карандаша **Edit this file**.
4. Внесите изменение.
5. Нажмите **Commit changes**.
6. Cloudflare автоматически запустит новый deployment.

Для нескольких файлов можно также нажать клавишу `.` на странице репозитория — откроется браузерный редактор github.dev.

---

# Что делает каждый файл

## `wrangler.jsonc`

Главная конфигурация Cloudflare.

Она сообщает Cloudflare:

- имя Worker — `airradar-mvp`;
- backend — `src/worker.js`;
- статические файлы — `public`;
- запросы `/api/*` нужно сначала направлять в Worker.

## `src/worker.js`

Наш backend.

Он принимает запросы браузера:

```text
/api/aircraft
/api/search
/api/icao/...
/api/health
```

и безопасно обращается к:

```text
https://api.adsb.lol
```

Таким образом браузеру не нужно напрямую работать с внешним ADS-B API.

## `public/index.html`

Разметка интерфейса.

## `public/app.css`

Внешний вид радара.

## `public/app.js`

Карта, самолёты, фильтры, поиск, карточка борта и обновление данных.

---

# Если Cloudflare пишет, что Worker name не совпадает

Проверьте `wrangler.jsonc`:

```json
"name": "airradar-mvp"
```

И создавайте/импортируйте Worker с тем же именем:

```text
airradar-mvp
```

---

# Если deployment упал

В Cloudflare:

1. Workers & Pages;
2. откройте `airradar-mvp`;
3. **Deployments**;
4. **View build history**;
5. откройте красный build;
6. посмотрите последние строки лога.

Самые вероятные причины:

### `wrangler.jsonc` not found

Файлы загружены не в корень GitHub-репозитория.

### Worker name mismatch

Имя Worker отличается от `airradar-mvp`.

### Wrong root directory

В настройках Cloudflare указан неправильный Root directory.

Для нашей структуры root должен быть корнем репозитория.

---

# Если сайт открылся, но самолётов нет

Сначала проверьте:

```text
/api/health
```

Если health работает, откройте:

```text
/api/aircraft?lat=55.75124&lon=37.61842&radius=100
```

Возможные ситуации:

1. **JSON с `ac` пришёл** — backend работает, проблема, скорее всего, во frontend.
2. **502 / upstream_unavailable** — Cloudflare не смог получить ответ от ADSB.lol.
3. **Ответ есть, но `ac` пустой** — на данный момент источник не получил позиции в выбранной области либо upstream изменил поведение.

---

# Если карта есть, но серый фон вместо тайлов

Картографическая подложка сейчас загружается из OpenStreetMap через Leaflet.

Проверьте, не блокирует ли браузер/корпоративная сеть:

```text
unpkg.com
openstreetmap.org
```

Сам ADS-B backend при этом может продолжать работать.

---

# Собственный домен — необязательно

Сначала лучше использовать бесплатный адрес:

```text
*.workers.dev
```

Позже можно привязать свой домен или поддомен, например:

```text
radar.example.ru
```

Это не требуется для работы MVP.

---

# Архитектура текущей версии

```text
Браузер
   │
   ├── HTML / CSS / JS
   │       ↑
   │  Cloudflare Static Assets
   │
   └── /api/*
           ↓
    Cloudflare Worker
           ↓
       ADSB.lol API
```

Никакого домашнего сервера и постоянно включённого компьютера нет.

---

# Ограничения MVP

1. Live-данные пока зависят от публичного API ADSB.lol.
2. ADSB.lol указывает, что API сейчас можно использовать бесплатно, но для production-применения рекомендует связаться с владельцем сервиса; в будущем может появиться API key.
3. История маршрута выбранного самолёта пока хранится только в памяти браузера.
4. Нет собственной постоянной базы PostgreSQL/D1.
5. Нет глобального viewport-агрегатора: текущая карта запрашивает область вокруг центра радиусом до 250 NM.
6. Маршрут рейса `SVO → LED` пока отдельно не обогащается.
7. Некоторые борта не имеют registration/operator/type в текущем ответе источника.

---

# Откуда данные и лицензии

ADS-B live data:

https://api.adsb.lol/

ADSB.lol публикует публичные данные/API под ODbL 1.0.

Карта:

https://www.openstreetmap.org/

Leaflet:

https://leafletjs.com/

Перед полноценным публичным или коммерческим запуском нужно ещё раз проверить актуальные условия поставщиков данных и требования к attribution.

---

# Что логично добавить следующим этапом

Текущая версия уже подходит для постоянного облачного MVP. Следующий архитектурный шаг:

```text
ADSB.lol / свои feeders
          ↓
 Cloudflare Worker
          ↓
 Cloudflare D1 / R2
          ↓
   история полётов
          ↓
 playback / избранное / alerts
```

Так можно добавить постоянную историю, маршруты, аэропорты, избранные борта и уведомления, не возвращаясь к локальному Python-серверу.
