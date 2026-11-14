# Pokrytí MyŠkoda Public API

Stav implementace 0.4.0, 31. 10. 2026. Veřejný kontrakt **1.1.0** byl znovu
stažen z https://public.api.connect.skoda-auto.cz/docs/myskoda-public-api.yaml.
Jeho přesná kopie je `myskoda-public-api-1.1.0.yaml` (SHA-256
`fb0514bf3e289e4bfb634f13dd5b7dfd24eb06cbab829ccf6a6fbb831ecf4cfc`).
Dokumentace: https://public.api.connect.skoda-auto.cz/docs.

## Rozsah

- **11/11 datových oblastí** dostupných přes jeden veřejný GET.
- **11/11 veřejných ovládacích operací** implementováno.
- **20 MCP nástrojů**: 9 pro čtení + 11 pro ovládání. Počty nástrojů a datových
  oblastí nejsou totéž. Počet operací nevyjadřuje váženou míru náročnosti.
- Žádná automatická aktivace oprávnění, ovládání při čtení nebo testování auta.

## Čtení

`GET /api/v1/vehicles/{vin}` podporuje všechny publikované `include`:
`info`, `status`, `fuelStatus`, `odometer`, `parkingPosition`,
`airConditioning`, `auxiliaryHeating`, `activeVentilation`, `charging`,
`chargingProfiles`, `operations`.

Zachováváme všechna vrácená pole uvnitř požadovaných oblastí; identifikátory
jsou maskované a soukromé oblasti se načítají odděleně. Chybějící hodnota je
neznámá, nepodporovaná služba není porucha. Poloha nemá ve veřejném kontraktu
čas měření. Časy profilů jsou místní časy vozidla bez zaručeného časového pásma.

## Ovládání

Cesty níže navazují na `/api/v1/vehicles/{vin}/`.

| Operace API | Metoda a cesta | MCP nástroj | Skupina oprávnění |
| --- | --- | --- | --- |
| startActiveVentilation | POST active-ventilation/start | start_active_ventilation | Ventilace |
| stopActiveVentilation | POST active-ventilation/stop | stop_active_ventilation | Ventilace |
| startCharging | POST charging/start | start_charging | Nabíjení a profily |
| stopCharging | POST charging/stop | stop_charging | Nabíjení a profily |
| setChargingLimit | PUT charging/limit | set_charging_limit | Nabíjení a profily |
| setChargeMode | PUT charging/mode | set_charge_mode | Nabíjení a profily |
| updateChargingProfile | PUT charging-profiles/{id} | update_charging_profile | Nabíjení a profily |
| startAirConditioning | POST air-conditioning/start | start_air_conditioning | Klimatizace |
| stopAirConditioning | POST air-conditioning/stop | stop_air_conditioning | Klimatizace |
| startAuxiliaryHeating | POST auxiliary-heating/start | start_auxiliary_heating | Přídavné topení |
| stopAuxiliaryHeating | POST auxiliary-heating/stop | stop_auxiliary_heating | Přídavné topení |

Všechny akce vyžadují výslovné povolení své skupiny v přihlášeném nastavení
a konkrétní lidský požadavek. Akceptace API není důkaz provedení na autě.

## Co je ověřeno

- Regresní a kontraktní testy: přesná shoda všech endpointů/metod/operationId
  a všech datových oblastí s uloženým oficiálním kontraktem.
- Simulace celého toku všech nových akcí: autentizovaný uživatel, skutečné SQL,
  čerstvý preflight, jediný zápis, ověření měření a opakované čtení výsledku.
- Simulace chyb: nepodporováno/vypnuto/nedostupné, nedostatek kvóty,
  zrušení povolení, výměna připojení, nejistý výsledek, duplicity a změna parametrů.
- Profil: shoda otisku, zachování ostatních polí, explicitní nahrazení seznamů,
  změna v MyŠkoda mezitím, chybějící profil a bezpečné číselné identifikátory.
- S-PIN: pouze nastavení, šifrování, redakce, smazání a vazba na připojení.
- Migrace z V3: zachování připojení, auditů a ventilace, nová oprávnění vypnutá.
- Skutečný lokální workerd: GET, POST a JSON PUT s vloženým simulátorem API.
- Formuláře: renderování, souhlasy, blokace povolení s expirovaným klíčem,
  možnost odvolat povolení a nezobrazování uloženého S-PINu.

## Co vyžaduje další ověření

Předchozí interní živý test ověřil všech 9 čtecích nástrojů na jednom spalovacím vozidle. Nejde o ověření nové instalace.
Nabíjení, klimatizace, přídavné topení a nabíjecí profily byly pro tento diesel
hlášené jako nepodporované. Jejich skutečný obsah a ovládání proto tímto autem
neprokážeme. Podporu start/stop ventilace auto hlásilo, skutečný příkaz dosud
nebyl součástí release testu. Nové vydání potřebuje samostatnou kontrolu v klientu.

Úspěšné simulace neprokazují provedení na reálném autě. Rozšířený bezpečnostní
audit a redesign připojování jsou navazující fáze. Prohlížečové interakce nejsou
nahrazené samotným renderovacím testem formulářů.

## Hranice veřejného API

Veřejný kontrakt nevystavuje zamykání/odemykání, klakson/blikání, ovládání
motoru/oken/kufru, GPS stream, historii jízd, servisní intervaly, DTC, tlak
pneumatik, zdraví baterie, webhooky ani vynucení nového měření auta. Neexistuje
publikovaný endpoint pro vytvoření/smazání nabíjecího profilu.

Vlastní historie, upozornění, exporty, plánování a více připojených aut mohou být
samostatné nadstavby. Nejsou chybějícími operacemi současného veřejného kontraktu
a v tomto vydání se nezapínají.
