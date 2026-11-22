package com.pantera.minibee_viewer

import com.google.android.play.agesignals.model.AgeSignalsErrorCode
import org.junit.Assert.assertEquals
import org.junit.Test

class AgePolicyTest {
  @Test
  fun adultBandStartsAtEighteen() {
    assertEquals(false, adultBand(null, null))
    assertEquals(false, adultBand(17, null))
    assertEquals(false, adultBand(16, 17))
    assertEquals(false, adultBand(18, 17))
    assertEquals(true, adultBand(18, null))
    assertEquals(true, adultBand(18, 18))
  }

  @Test
  fun sharedPlayBand() {
    assertEquals(AgeVerdict.Block(BlockReason.NotShared), sharedAgeVerdict(null, null))
    assertEquals(AgeVerdict.Block(BlockReason.Underage), sharedAgeVerdict(16, 17))
    assertEquals(AgeVerdict.Allow, sharedAgeVerdict(18, null))
  }

  @Test
  fun playDiscoveryDoesNotTreatSilenceAsPermission() {
    assertEquals(PlayFailure.Block, playDiscoveryFailure(null, storeInstall = true))
    assertEquals(
      PlayFailure.Block,
      playDiscoveryFailure(AgeSignalsErrorCode.APP_NOT_OWNED, storeInstall = true)
    )
    assertEquals(
      PlayFailure.Retry,
      playDiscoveryFailure(AgeSignalsErrorCode.NETWORK_ERROR, storeInstall = true)
    )
    assertEquals(
      PlayFailure.Block,
      playDiscoveryFailure(AgeSignalsErrorCode.SDK_VERSION_OUTDATED, storeInstall = true)
    )
    assertEquals(
      PlayFailure.Allow,
      playDiscoveryFailure(AgeSignalsErrorCode.DEVICE_NOT_SUPPORTED, storeInstall = true)
    )
  }

  @Test
  fun debugSideloadStillOpensWhenPlayDoesNotOwnIt() {
    assertEquals(
      PlayFailure.Allow,
      playDiscoveryFailure(AgeSignalsErrorCode.APP_NOT_OWNED, storeInstall = false)
    )
    assertEquals(PlayFailure.Allow, playDiscoveryFailure(null, storeInstall = false))
  }

  @Test
  fun amazonOnlyEmptySuccessSkipsTheCheck() {
    assertEquals(AgeVerdict.Allow, amazonVerdict("SUCCESS", "", null, null))
    assertEquals(AgeVerdict.Allow, amazonVerdict("SUCCESS", "VERIFIED", 18, null))
    assertEquals(
      AgeVerdict.Block(BlockReason.Unconfirmed),
      amazonVerdict("SUCCESS", "VERIFIED", 18, 18)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.Unconfirmed),
      amazonVerdict("SUCCESS", "VERIFIED", 19, null)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.Unconfirmed),
      amazonVerdict("SUCCESS", "VERIFIED", null, null)
    )
    assertEquals(AgeVerdict.Block(BlockReason.Unconfirmed), amazonVerdict("SUCCESS", " ", null, null))
    assertEquals(
      AgeVerdict.Block(BlockReason.Unconfirmed),
      amazonVerdict("SUCCESS", " VERIFIED", 18, null)
    )
    assertEquals(AgeVerdict.Retry, amazonVerdict(null, "", null, null))
    assertEquals(AgeVerdict.Retry, amazonVerdict("SUCCESS", null, 18, null))
    assertEquals(AgeVerdict.Allow, amazonVerdict("FEATURE_NOT_SUPPORTED", "", null, null))
    assertEquals(
      AgeVerdict.Block(BlockReason.Underage),
      amazonVerdict("SUCCESS", "SUPERVISED", 16, 17)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.Underage),
      amazonVerdict("SUCCESS", "VERIFIED", 16, 17)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.Unconfirmed),
      amazonVerdict("SUCCESS", "UNKNOWN", null, null)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.ConsentNotGranted),
      amazonVerdict("SUCCESS", "CONSENT_NOT_GRANTED", null, null)
    )
    assertEquals(AgeVerdict.Retry, amazonVerdict("INTERNAL_TRANSIENT_ERROR", "", null, null))
    assertEquals(
      AgeVerdict.Block(BlockReason.StoreUnreachable),
      amazonVerdict("INTERNAL_ERROR", "", null, null)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.StoreUnreachable),
      amazonVerdict("APP_NOT_OWNED", "", null, null)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.StoreUnreachable),
      amazonVerdict("SOMETHING_NEW", "", null, null)
    )
  }
}
