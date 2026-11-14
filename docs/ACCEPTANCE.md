# Ruční ověření instalace

Release testy jsou lokální simulace. Tento seznam je připravený pro následný
test s uživatelem; žádný krok s ovládáním se nespouští automaticky.

1. V nově načteném klientu zkontrolovat **20 nástrojů**: devět původních čtecích
   a jedenáct ovládacích. Pouhá přítomnost nástroje není povolení jej zavolat.
2. Zavolat pouze `get_connection_status`. Ověřit zachované připojení,
   vypnuté nové skupiny ovládání a `auxiliaryHeatingSpinConfigured: false`.
   Stav ventilace odpovídá dřívějšímu výslovnému nastavení uživatele.
3. Jednou načíst přehled, stav, energii, klima a schopnosti; kompatibilní pohledy
   mají sdílet mezipaměť. Zachovat skutečné časy měření a odlišit nepodporovanou
   funkci od poruchy. Polohu ani profily nenačítat bez odpovídajícího dotazu.
4. V přihlášeném nastavení ověřit, že každá nová skupina má samostatný souhlas.
   Pro nepodporované funkce ponechat odpovídající skupiny vypnuté.
   Neposílat příkaz nepodporované funkci jen kvůli testu.
5. Teprve pokud uživatel povolí ventilaci v nastavení a výslovně požádá o
   konkrétní spuštění, provést jeden `start_active_ventilation`. Uchovat stejné
   `requestId` pro tentýž úmysl. Vyhodnotit `status`, `executionConfirmed` a čas
   následného měření. Přijetí bez čerstvého měření označit jako nepotvrzené.
6. Zastavení provést až na samostatný výslovný požadavek uživatele. Nevytvářet
   automatické opakování nebo sledování. Každá akce obvykle spotřebuje až tři
   požadavky API; aktuální hlavičky a souběžní klienti rozhodují o kvótě.
7. Po odvolání povolení ověřit pouze místní stav připojení. Nevysílat příkaz
   na auto pro ověření blokace; to je pokryté simulacemi.

Podpora nabíjení, profilů, klimatizace a přídavného topení závisí na konkrétním vozidle. U těchto funkcí zůstane výsledek **implementováno,
simulačně ověřeno, živě neověřeno**. S-PIN není potřeba zadávat, pokud se přídavné
topení nebude používat. PIN ani API klíč se nikdy nepředávají v chatu.
