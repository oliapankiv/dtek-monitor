# DTEK - сповіщення про зміну графіка відключень

Every ~10 minutes GitHub Actions opens https://www.dtek-krem.com.ua/ua/shutdowns,
reads the embedded schedule (`DisconSchedule.fact`) and, if it changed since the
last run, sends a Telegram message with the outage intervals for your queue(s).
