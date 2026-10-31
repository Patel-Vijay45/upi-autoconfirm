package app.autoconfirm.parse

sealed interface ParseResult {
    /** Not a payment app in the rules: ignore immediately, read nothing else. */
    data object NotPaymentApp : ParseResult
    data class Ignored(val reason: String) : ParseResult
    data class Payment(val app: String, val amountPaise: Long, val payerShort: String?, val reference: String?) : ParseResult
    /** Looks like money (₹ / Rs) but no rule matched: counted so rules can be fixed. Text is never stored. */
    data class Failed(val app: String) : ParseResult
}

object NotificationParser {
    private val MONEY_HINT = Regex("(₹|(?i)\\b(rs\\.?|inr)\\s?\\d)")

    /** Order of checks (ANDROID-APP.md §4.2): package → ignore patterns → incoming patterns → failure. */
    fun parse(rules: ParserRules, pkg: String, title: String, text: String, bigText: String): ParseResult {
        val app = rules.forPackage(pkg) ?: return ParseResult.NotPaymentApp
        val any = listOf(title, text, bigText).filter { it.isNotEmpty() }.joinToString("\n")
        val fields = mapOf("title" to title, "text" to text, "big_text" to bigText, "any" to any)

        if (app.ignore.any { it.containsMatchIn(any) }) return ParseResult.Ignored("ignore_pattern")

        for (p in app.incoming) {
            val source = fields[p.field] ?: continue
            val m = p.regex.find(source) ?: continue
            val amount = m.groupValues.getOrNull(p.amountGroup)?.let(Money::toPaise) ?: continue
            if (amount <= 0) continue
            val payer = p.payerGroup?.let { m.groupValues.getOrNull(it) }?.let(Payer::short)
            val reference = p.referenceGroup?.let { m.groupValues.getOrNull(it) }?.trim()?.take(64)?.takeIf { it.isNotEmpty() }
            return ParseResult.Payment(app.id, amount, payer, reference)
        }
        return if (MONEY_HINT.containsMatchIn(any)) ParseResult.Failed(app.id) else ParseResult.Ignored("no_amount")
    }
}
