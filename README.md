<img width="1726" height="845" alt="Dashboard SWARM" src="https://github.com/user-attachments/assets/9792915e-517a-423f-b059-e9eff99792b0" />

# SWARM

**Lokalny, sfederowany framework wieloagentowy, który zamienia tablicę projektu w dostarczony kod.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict%20%2B%20ESM-3178c6.svg)](https://www.typescriptlang.org/)

Przesuń kartę do **Ready**, a resztą zajmie się SWARM. Agent kodujący planuje
zadanie, implementuje je w odizolowanym worktree Gita na maszynie, która należy
do *ciebie*, otwiera pull request, recenzuje go jako **osobna tożsamość**,
odpowiada na własne review, naprawia czerwone CI, rozwiązuje konflikty i
przesuwa kartę do **Done**. Na każdym kroku komentuje na tablicy, więc człowiek
może śledzić postęp albo w każdej chwili wkroczyć.

Twój kod źródłowy nigdy nie opuszcza twojej maszyny. Control plane widzi
wyłącznie metadane zadań, komentarze i logi.

---

## Jak to działa w jednym obrazku

```text
   ┌──────────────────────────────────────────────────────────────────────┐
   │  Tablica: GitHub Projects · Linear · Jira · Trello                   │
   │  Kod:     GitHub · Bitbucket Cloud · GitLab · Azure DevOps           │
   └───────────────┬──────────────────────────────────────────────────────┘
                   │  podpisany webhook (HTTPS, zwykle Cloudflare Tunnel)
                   ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  Router (control plane)                                              │
   │  weryfikacja → zdarzenie niezależne od providera → trwały dispatch   │
   │  w Postgresie → wybudzenie przez Redis → bramka → wybór workera      │
   └───────────────┬──────────────────────────────────────────────────────┘
                   │  TaskAssignment przez uwierzytelniony WebSocket
                   │  (nigdy sekret projektu)
                   ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  Worker — twoja maszyna, twój PATH, twoje loginy CLI                 │
   │  odizolowany worktree → claude / agy / codex → ustrukturyzowany      │
   │  hand-off                                                            │
   └───────────────┬──────────────────────────────────────────────────────┘
                   │  wynik wraca strumieniem
                   ▼
      SWARM dostarcza: commit · push · PR · review · ruch na tablicy
```

## Dlaczego to nie jest po prostu agent w pętli

**To pipeline, a nie prompt.** Sześć odrębnych faz, każda z własnym
wyzwalaczem, trybem worktree, promptem, schematem hand-offu i regułami
dostarczania. „Zaimplementuj to” i „zrecenzuj to” to naprawdę różne zadania z
różnymi poświadczeniami, a nie ten sam agent grzecznie poproszony o coś innego.

**Agent pisze kod, a SWARM go dostarcza.** Każda faza kończy się
ustrukturyzowanym hand-offem walidowanym schematem Zod. Commity, pushe, pull
requesty, review i ruchy na tablicy wykonuje potem *SWARM* na podstawie tego
hand-offu, nigdy agent na własną rękę. Hand-off, który nie przejdzie walidacji,
dostaje dokładnie jedną próbę naprawy. Potem run kończy się wyraźnym błędem,
zamiast dostarczyć coś w połowie.

**Dwie tożsamości, żeby review coś znaczyło.** Implementacja działa jako
persona implementera. Review jest wysyłane przez osobne poświadczenie
reviewera, przypisane do projektu i wybierane dla każdego wywołania przez
`AsyncLocalStorage`. Każdy provider ustala własną tożsamość na potrzeby
zapobiegania pętlom, więc SWARM nigdy nie reaguje na własne zdarzenia.

**Twój kod zostaje na miejscu.** Klonowanie, worktree, uruchomienia CLI agentów
i pushe odbywają się na twojej maszynie, w `.swarm-workspaces/task-<id>/`.
Daemon workera nie ma `DATABASE_URL`, `REDIS_URL` ani żadnego sekretu projektu.
Wszystko, co go wymaga (werdykt reviewera, ruch na tablicy, rejestr werdyktów),
wraca do API dostarczania w control plane.

**Niezależny od providera na każdej osi.** Trzech providerów kontroli wersji,
cztery tablice projektów, trzy CLI agentów, a *żaden* z nich nie jest nazwany w
kodzie pipeline'u, wyzwalaczy ani workera. Nowy provider to implementacja
interfejsu, a nie fork: piętnaście metod wychodzących i pięć przychodzących,
zadeklarowanych jako dane w manifeście, oraz zestaw testów zgodności, który nie
pozwoli zarejestrować providera, dopóki choć jedna metoda jest atrapą.

**Trwałość z założenia.** Postgres przechowuje maszynę stanów dispatchu. Redis
przenosi tylko wybudzenia i nigdy nie jest źródłem prawdy. Webhooki są
deduplikowane po identyfikatorze dostawy nadanym przez providera, a dispatche po
deterministycznych kluczach (repo, PR, head). Ponownie dostarczony webhook,
retry kolejki czy restart workera w trakcie dostarczania dają więc dokładnie
jeden run i jeden komentarz.

**Ograniczenia, żeby nic nie wymknęło się spod kontroli.** Trwały rejestr
ogranicza każdy pull request do trzech wysłanych werdyktów (uprawniony operator
może przyznać dokładnie jeden więcej). Próby naprawy CI mają limit na PR.
„Provider odpowiedział, ale jeszcze nie ostatecznie” i „odczyt w ogóle nie
odpowiedział” zużywają *osobne* budżety ponownych sprawdzeń, więc awaria DNS
nie wyczerpie po cichu puli, której potrzebuje wolne CI. Każda rezygnacja
zostawia wiersz runu ze statusem `failed`, który operator widzi i może ponowić.

**Prawdziwa bramka dispatchu.** Zanim powstanie jakikolwiek worktree czy agent,
SWARM sprawdza, czy fazę może przyjąć *uprawniony* worker: aktywna rejestracja w
projekcie, zgoda właściciela na udostępnianie, żywe połączenie, wolna pojemność,
obsługiwana faza, skonfigurowane CLI oraz to, że checkout na hoście jest
właściwym repozytorium. Przypisana praca działa na maszynie osoby przypisanej i
na żadnej innej. Jedna reguła dla każdego wdrożenia: instalacja jednoosobowa
rejestruje swojego jedynego lokalnego workera dokładnie tak samo jak każdy inny.

**Obsługa z dashboardu**, a nie z pliku logów: historia runów i szczegóły
każdego runu z diagnozą błędu, sekcja **Stalled** wskazująca zadania, które
przestały się ruszać, mapowanie projektów i tablic, wprowadzanie poświadczeń
per provider, rejestracja i zatwierdzanie workerów oraz bieżący limit CLI
każdego z twoich workerów.

## Sześć faz

| Faza | Startuje, gdy | Agent | SWARM potem |
| --- | --- | --- | --- |
| **Planning** | Karta trafia do *Planning* i nie ma jeszcze etykiety `planned` | Czyta zadanie w worktree tylko do odczytu i pisze `proposed_plan.md`. Gdy włączone jest `verifyPlan` (domyślnie wyłączone), drugi, niezależny agent najpierw sprawdza plan z repozytorium, poprawia na miejscu błędne ścieżki, symbole i twierdzenia i odnotowuje w planie, że został sprawdzony | Publikuje plan w zadaniu. Przesuwa kartę dalej tylko przy włączonym `autoAdvance` (domyślnie wyłączone) |
| **Implementation** | Karta trafia do *Ready* | Implementuje i weryfikuje na gałęzi zadania, pisze ustrukturyzowany hand-off | Waliduje, commituje, pushuje, otwiera albo ponownie używa PR, linkuje go na karcie i przesuwa ją do *In review* |
| **Review** | Przechodzą checki PR zarządzanego przez SWARM (otwarty PR na nie czeka, a bez CI przy `if-present` jest recenzowany od razu po otwarciu) albo okresowe sprawdzenie znajdzie PR gotowy i bez review | Recenzuje na SHA heada PR i zwraca ustrukturyzowane uwagi | Sam składa treść review, wysyła ją jako reviewer i zużywa miejsce w rejestrze werdyktów |
| **Respond-to-review** | Reviewer prosi o zmiany | Odnosi się do każdego punktu, pisze ustrukturyzowaną odpowiedź | Commituje i pushuje poprawkę, publikuje odpowiedź, kolejkuje dokładnie jedno kolejne Review dla nowego heada |
| **Respond-to-CI** | Na gałęzi zadania pada check, a błąd nie wynika z tego, że ten sam check jest już czerwony na gałęzi bazowej PR ([docs/pipeline.md](docs/pipeline.md#base-branch-health)) | Naprawia błąd albo zgłasza, że nie potrafi | Commituje, pushuje i wyjaśnia na PR, z limitem prób na PR; po jego wyczerpaniu zapisuje trwałą rezygnację. Zgłoszenie, że builda nie da się naprawić, oddaje PR z powrotem do Review zamiast kończyć sprawę |
| **Resolve conflicts** | Potwierdzono konflikt PR z gałęzią bazową | Merguje aktualną bazę i rozwiązuje konflikty | Commituje i pushuje. Ponowne sprawdzenia są scalane, ograniczone i deduplikowane |

Wszystkie sześć faz działa na dowolnym workerze i przez ten sam transport. To,
którą maszyną jest dany worker, nie ma znaczenia. Jest jeden celowy wyjątek:
faza, która *kontynuuje* pracę już leżącą na dysku (zachowany checkout jest
lokalny dla maszyny i nie ma kopii na serwerze), trafia tylko do workera, który
go trzyma, zamiast po cichu zaczynać od nowa gdzie indziej.

## Z czym współpracuje

| Oś | Obsługiwane dziś |
| --- | --- |
| **Kontrola wersji** | GitHub · Bitbucket Cloud · gitlab.com · Azure DevOps Services |
| **Tablice projektów** | GitHub Projects v2 · Linear · Jira Cloud · Trello |
| **CLI agentów** | `claude` (Claude Code) · `agy` (Antigravity) · `codex` |
| **Środowisko** | Node 22+ · Postgres · Redis · Docker Compose |

Każdy projekt wskazuje własnego providera kontroli wersji i własną tablicę, więc
jedna instalacja może obsługiwać projekt GitHub/Jira obok projektu
GitLab/Linear.

## Na czym zbudowany

TypeScript (strict, ESM) · Hono · tRPC · Drizzle + Postgres · BullMQ + Redis ·
Zod jako źródło prawdy dla każdego schematu · React + TanStack Router + Vite w
dashboardzie · Vitest · Biome · Lefthook.

Około 74 tys. linii kodu aplikacji i 34 tys. dashboardu wobec 88 tys. linii
testów: mniej więcej 5000 przypadków testowych w 258 plikach. Wszystkie
uruchamia `npm run verify` (lint + typecheck + testy), lokalnie i przy każdym
pull requeście.

## Decyzje projektowe warte przeczytania

Najciekawsze rzeczy są spisane jako ADR, a nie zostawione w kodzie:

- [ADR-002](./docs/decisions/ADR-002-durable-dispatch-state-machine.md): jedna trwała maszyna stanów dispatchu do orkiestracji *(przyjęty)*
- [ADR-003](./docs/decisions/ADR-003-worker-transport-and-split-delivery.md) / [ADR-004](./docs/decisions/ADR-004-worker-transport-and-split-delivery.md): transport worker↔control plane i dzielone dostarczanie, czyli dlaczego worker dostaje WebSocket i przydział zadania zamiast adresu bazy danych *(przyjęty)*
- [ADR-006](./docs/decisions/ADR-006-unconditional-worker-updates.md): worker aktualizuje się, gdy instalacja go o to poprosi, czyli dlaczego usunięto opcjonalną samoaktualizację per host *(przyjęty)*

[`ai/ARCHITECTURE.md`](./ai/ARCHITECTURE.md) opisuje architekturę taką, jaka
faktycznie jest zbudowana, a [`docs/pipeline.md`](./docs/pipeline.md) cykl życia
faz, model bezpieczeństwa i granice providerów.

---

## Szybki start

Z katalogu głównego repozytorium:

```bash
npm install
cp .env.docker.example .env       # ustaw hasła
cd dashboard && npm install && cd ..
docker compose up -d --build      # Postgres, Redis i router
npm run db:migrate
npm run db:seed                   # wczytuje swarm.config.json do Postgresa
```

Zarejestruj tę maszynę jako workera. Robi to każde wdrożenie: faza albo działa
na zarejestrowanym workerze, albo czeka.

```bash
npm run swarm -- login --identifier localhost-admin
npm run swarm -- workers register-and-enroll localhost-admin <project-id> \
  --name "this machine" --cli claude --control-plane-url http://localhost:3100
```

`--control-plane-url` to bazowy adres routera, z którym rozmawia worker tej
maszyny: tu loopback, a na zdalnej maszynie adres tunelu. Komenda zapisuje go w
`.env`, jeśli ten plik jeszcze go nie zawiera, więc nic nie trzeba edytować
ręcznie. Podawaj go tylko na maszynie, która nie została jeszcze skierowana na
żadną instalację.

Potem uruchom procesy i otwórz <http://localhost:5173>:

```bash
npm run dev:api                   # API na 127.0.0.1:3101
npm run dev:dashboard             # dashboard na localhost:5173
npm run dev:worker                # worker
```

Worker zajmuje ten terminal tak długo, jak maszyna ma przyjmować pracę. **Na
macOS** może zamiast tego działać jako agent launchd uruchamiany przy
logowaniu. Uruchom to z checkoutu, dla którego worker został zarejestrowany:

```bash
swarm-worker-agent install        # potem: status · logs · update · uninstall
```

Lokalna instalacja jest domyślnie jednoosobowa: bez zakładania konta, bez hasła
i bez `/login`. Wymagania wstępne, wariant wieloosobowy i pełny poradnik workera
są w [`docs/MANUAL.md`](docs/MANUAL.md).

### Co robi `install`

`swarm-worker-agent install [<checkout>]` zamienia checkout, dla którego worker
jest już zarejestrowany, w LaunchAgent uruchamiany przy logowaniu i
restartowany, gdy padnie. Kolejno:

1. **Ustala checkout.** `<checkout>` (domyślnie bieżący katalog) jest
   rozwiązywany do ścieżki rzeczywistej. Z niej wynika wszystko inne: sha256,
   które jest kluczem cache'u poświadczeń i blokady checkoutu, oraz etykieta
   agenta `pl.smarttechbrewery.swarm.worker.<basename>.<hash8>`.
2. **Sprawdza warunki wstępne** i odmawia z komunikatem, gdy któryś nie jest
   spełniony:
   - katalog jest checkoutem gita (istnieje `.git`);
   - jest dla niego zarejestrowany worker, czyli istnieje
     `~/.swarm/worker-credentials/<hash>/credential.json`. Bez tego agent
     padałby przy każdym starcie, a launchd restartowałby go w nieskończoność,
     więc najpierw zarejestruj workera (`swarm workers setup` albo
     `register-and-enroll`);
   - `node` i `swarm` są w `PATH`. Ich bezwzględne ścieżki trafiają do plisty,
     więc agent dalej uruchamia binarki aktualne w chwili instalacji.
3. **Odmawia, jeśli checkout trzyma już inny worker.** Czyta blokadę checkoutu
   daemona (`~/.swarm/checkout-locks/<hash>/owner.json`) i odmawia, gdy zapisany
   pid należy do działającego daemona workera, podając jego nazwę. Nie odmawia
   w dwóch przypadkach:
   - blokada jest nieaktualna: procesu o tym pid już nie ma albo jej
     `refreshedAt` jest starsze niż 15 minut;
   - blokadę trzyma działający agent tego samego checkoutu, który i tak zostanie
     zastąpiony w kroku 5.
4. **Zapisuje plistę** do `~/Library/LaunchAgents/<label>.plist` i waliduje ją
   przez `plutil -lint`. Agent:
   - uruchamia `node <swarm> run:worker` z checkoutem jako `WorkingDirectory`.
     W ten sposób daemon znajduje swoje zapisane poświadczenie. Do plisty nie
     trafia żaden sekret;
   - dostaje `PATH` złożony z katalogów, w których znaleziono `node`, `npm`,
     `git`, `gh`, `claude`, `codex` i `agy`, oraz ze standardowych katalogów
     systemowych. Bez tego daemon widziałby minimalny `PATH` launchd, w którym
     nie ma CLI agentów;
   - ma ustawione `RunAtLoad` i `KeepAlive`, z 30-sekundowym
     `ThrottleInterval` między restartami;
   - loguje do `~/Library/Logs/<label>.log` i `<label>.error.log`.
5. **(Re)startuje agenta.** Usuwa istniejące zadanie o tej etykiecie
   (`launchctl bootout`) i ładuje nową plistę do domeny GUI użytkownika
   (`launchctl bootstrap gui/<uid>`), więc worker startuje od razu. Wypisuje
   etykietę, checkout i ścieżkę do logu.

Ponowne uruchomienie `install` przy działającym agencie jest bezpieczne i jest
zwykłym sposobem na wczytanie zmian w pliście: przeniesionego `node`, nowo
zainstalowanego CLI agenta albo nowych dodatkowych checkoutów po
`add-checkout`.

## Wydawanie wersji

Nową wersję wydaje się jedną komendą, z czystego `main`:

```bash
npm run release
```

Skrypt [`bin/swarm-release`](bin/swarm-release):

1. Pobiera aktualny `main` i pokazuje obecną wersję oraz ostatni tag.
2. Prosi o nową wersję w formacie `X.Y.Z`. Odrzuca zły format, wersję niższą od
   obecnej i istniejący już tag.
3. Ostrzega, jeśli od poprzedniego tagu zmieniło się `deploy/vps`. Wtedy pliki na
   serwerze (compose, Caddyfile, `.env`) mogą wymagać admina.
4. Podbija wersję w `package.json`, commituje `chore(release): vX.Y.Z` na `main`,
   tworzy tag `vX.Y.Z` i wypycha oba. Hook pre-push uruchamia przy tym testy.
5. Czeka, aż GitHub Actions zbuduje obraz `ghcr.io/smarttechbrewery/swarm:vX.Y.Z`
   i przesunie na niego tag `:stable`.
6. Publikuje GitHub Release z notatkami wygenerowanymi z PR-ów.
7. Robi deploy na VPS (`sudo dockerctl deploy app`). Migracje uruchamiają się
   same przy starcie.
8. Sprawdza, że `/health` odpowiada i że dashboard pokazuje nową wersję.

Wymaga zalogowanego `gh` i dostępu SSH do serwera. Adres serwera można nadpisać
zmiennymi `SWARM_DEPLOY_SSH` (domyślnie `jkwiecien@51.255.194.195`) i
`SWARM_DEPLOY_URL` (domyślnie `https://swarm-sm.pl`).

## Dokumentacja

Wszystko inne jest w [`docs/MANUAL.md`](docs/MANUAL.md): wymagania wstępne, jak
działa worker i czego celowo nie przechowuje, opis komend, warstwy konfiguracji
oraz mapa wszystkich pozostałych dokumentów.

## Stan projektu

Wczesny, ale działający, i używany do budowy samego siebie: wszystkie sześć faz
działa od początku do końca na tym repozytorium, więc zadania z tablicy są
planowane, implementowane, recenzowane i mergowane przez sam SWARM. Ponad 300
commitów w tym repozytorium napisała jego własna persona implementera, a
zatwierdziła jego własna persona reviewera.

[`docs/status.md`](./docs/status.md) to rzetelny przegląd stanu obszar po
obszarze, łącznie z tym, co jest zweryfikowane testami jednostkowymi, ale nie
było jeszcze uruchamiane na żywym providerze.

## Współtworzenie

Przed wprowadzeniem zmian przeczytaj [`ai/RULES.md`](./ai/RULES.md). Przed
zgłoszeniem zmiany uruchom `npm run verify`. GitHub Actions uruchamia tę samą
weryfikację dla każdego pull requesta.

## Licencja

SWARM jest udostępniany na [licencji Apache 2.0](./LICENSE).
