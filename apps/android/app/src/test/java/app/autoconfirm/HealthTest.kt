package app.autoconfirm

import app.autoconfirm.work.Health
import org.junit.Assert.assertEquals
import org.junit.Test

class HealthTest {
    @Test fun warns_only_for_a_paired_unpaused_phone_without_notification_access() {
        assertEquals(true, Health.needsWarning(paired = true, paused = false, listenerOn = false))
        assertEquals(false, Health.needsWarning(paired = true, paused = false, listenerOn = true))
        assertEquals(false, Health.needsWarning(paired = true, paused = true, listenerOn = false)) // paused on purpose
        assertEquals(false, Health.needsWarning(paired = false, paused = false, listenerOn = false)) // not set up yet
    }
}
