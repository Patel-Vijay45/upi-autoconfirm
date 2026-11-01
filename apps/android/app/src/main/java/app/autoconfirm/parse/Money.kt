package app.autoconfirm.parse

/** Money is integer paise everywhere. Never use floating point. */
object Money {
    private val AMOUNT = Regex("^(\\d{1,9})(?:\\.(\\d{1,2}))?$")
    private val PREFIX = Regex("^(?i)(rs\\.?|inr)")

    /** "930.07" -> 93007, "930.7" -> 93070, "1,250.50" -> 125050. Null if not an amount. */
    fun toPaise(raw: String): Long? {
        val cleaned = raw.replace(Regex("[₹\\s,]"), "").replace(PREFIX, "")
        val m = AMOUNT.matchEntire(cleaned) ?: return null
        val rupees = m.groupValues[1].toLong()
        val frac = m.groupValues[2].padEnd(2, '0')
        return rupees * 100 + frac.toLong()
    }

    /** 93007 -> "930.07" */
    fun format(paise: Long): String = "${paise / 100}.${(paise % 100).toString().padStart(2, '0')}"
}

/** Data minimisation: "RAMESH PATEL" -> "Ramesh P". Same rule as the server. */
object Payer {
    private val HONORIFICS = setOf("mr", "mrs", "ms", "miss", "dr", "shri", "sri", "smt", "kumari", "km")

    fun short(name: String?): String? {
        if (name.isNullOrBlank()) return null
        // Titles like "Mr." would otherwise become the first name ("Mr. V").
        val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.dropWhile { it.trimEnd('.').lowercase() in HONORIFICS }
        if (words.isEmpty()) return null
        val first = words[0].take(20).lowercase().replaceFirstChar { it.uppercase() }
        val initial = words.getOrNull(1)?.firstOrNull()?.uppercaseChar()
        return if (initial != null) "$first $initial" else first
    }
}
