package com.pantera.minibee_viewer

import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.play.agesignals.AgeSignalsAccessRequest
import com.google.android.play.agesignals.AgeSignalsException
import com.google.android.play.agesignals.AgeSignalsManager
import com.google.android.play.agesignals.AgeSignalsManagerFactory
import com.google.android.play.agesignals.AgeSignalsRequest
import com.google.android.play.agesignals.ApplicableAgeFeaturesRequest
import com.google.android.play.agesignals.model.AgeSignalsStatus
import com.google.android.play.agesignals.model.ApplicableAgeFeature
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

// Launcher of every Android build; MainActivity (and the Rust session) starts
// only after this gate allows it. Only a copy that Play or Amazon installed
// (the AAB the stores ship) ever asks a store: the GitHub APK is installed by
// neither and opens at once (see begin). The age band is never put on an
// Intent, written down, or logged. Play's install id and Amazon's user id are
// not read.
class AgeGateActivity : AppCompatActivity() {
  companion object {
    // True once this process may run the viewer: the gate let it through, or
    // there was no store to ask. A MainActivity brought back in a new process
    // (process death, then recents) sees false; see MainActivity.onCreate.
    @Volatile var passedThisProcess: Boolean = false

    // Whether a store is asked before this copy opens: one that Play or
    // Amazon installed, and any debug build (see begin). The GitHub APK has
    // nobody to ask.
    fun asksAStore(context: Context): Boolean =
      BuildConfig.DEBUG || installStore(installerOf(context)) != InstallStore.Other

    private fun installerOf(context: Context): String? {
      return try {
        val packages = context.packageManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          val info = packages.getInstallSourceInfo(context.packageName)
          info.installingPackageName ?: info.initiatingPackageName
        } else {
          @Suppress("DEPRECATION")
          packages.getInstallerPackageName(context.packageName)
        }
      } catch (_: Exception) {
        null
      }
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private val signals: AgeSignalsManager by lazy {
    AgeSignalsManagerFactory.create(applicationContext)
  }
  private var generation = 0
  private var step = 0
  private var opened = false
  private var recheckOnResume = false

  private lateinit var progress: ProgressBar
  private lateinit var titleView: TextView
  private lateinit var messageView: TextView
  private lateinit var primary: Button
  private lateinit var secondary: Button

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // The icon brings this activity forward even when the viewer is already
    // the task. Finishing reveals it; a cold start is the task root and stays.
    if (!isTaskRoot && isLauncherIntent(intent)) {
      finish()
      overridePendingTransition(0, 0)
      return
    }
    setContentView(R.layout.activity_age_gate)
    val root = findViewById<View>(R.id.age_gate_root)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    progress = findViewById(R.id.age_gate_progress)
    titleView = findViewById(R.id.age_gate_title)
    messageView = findViewById(R.id.age_gate_message)
    primary = findViewById(R.id.age_gate_primary)
    secondary = findViewById(R.id.age_gate_secondary)
    begin()
  }

  override fun onResume() {
    super.onResume()
    if (recheckOnResume) {
      recheckOnResume = false
      begin()
    }
  }

  override fun onDestroy() {
    generation += 1
    handler.removeCallbacksAndMessages(null)
    super.onDestroy()
  }

  private fun begin() {
    handler.removeCallbacksAndMessages(null)
    val token = ++generation
    showChecking()
    when (installStore(installerOf(this))) {
      // A release sideload (the GitHub APK) never asks. A debug sideload makes
      // one Play call so a licence tester can exercise the live API; attempt
      // 2 means that call does not retry, so a machine without Play Store
      // still opens at once.
      InstallStore.Other -> if (BuildConfig.DEBUG) discoverPlay(token, 2, false) else openViewer()
      InstallStore.Play -> discoverPlay(token, 0, true)
      InstallStore.Amazon -> discoverAmazon(token, 0)
    }
  }

  private fun discoverPlay(token: Int, attempt: Int, storeInstall: Boolean) {
    val stamp = ++step
    signals.getApplicableAgeFeatures(ApplicableAgeFeaturesRequest.builder().build())
      .addOnSuccessListener { result ->
        if (!current(token, stamp)) return@addOnSuccessListener
        val mandatory = result.features()?.contains(ApplicableAgeFeature.MANDATORY_SHARING) == true
        if (mandatory) {
          requestPlayAccess(token, 0)
        } else {
          openViewer()
        }
      }
      .addOnFailureListener { error ->
        if (!current(token, stamp)) return@addOnFailureListener
        val code = playCode(error)
        when (playDiscoveryFailure(code, storeInstall)) {
          PlayFailure.Allow -> openViewer()
          PlayFailure.Block -> showBlock(playBlockReason(code))
          PlayFailure.Retry -> if (attempt >= 2) {
            // Retries exhausted. A Play install still does not know whether
            // sharing is mandatory, so it stops. A debug sideload opens.
            if (storeInstall) showBlock(playBlockReason(code)) else openViewer()
          } else {
            retryLater(token, attempt) { discoverPlay(token, attempt + 1, storeInstall) }
          }
        }
      }
  }

  private fun requestPlayAccess(token: Int, attempt: Int) {
    val stamp = ++step
    val request = AgeSignalsAccessRequest.builder()
      .setActivity(this)
      .build()
    signals.requestAgeSignalsAccess(request)
      .addOnSuccessListener { access ->
        if (!current(token, stamp)) return@addOnSuccessListener
        when (access.ageSignalsStatus() ?: AgeSignalsStatus.UNSPECIFIED) {
          AgeSignalsStatus.SHARED -> readPlayAges(token, 0)
          AgeSignalsStatus.VERIFICATION_REQUIRED -> showBlock(BlockReason.VerificationRequired)
          AgeSignalsStatus.NOT_SHARED -> showBlock(BlockReason.NotShared)
          else -> showBlock(BlockReason.Unconfirmed)
        }
      }
      .addOnFailureListener { error ->
        if (!current(token, stamp)) return@addOnFailureListener
        onMandatoryFailure(token, attempt, error) { requestPlayAccess(token, attempt + 1) }
      }
  }

  private fun readPlayAges(token: Int, attempt: Int) {
    val stamp = ++step
    signals.checkAgeSignals(AgeSignalsRequest.builder().build())
      .addOnSuccessListener { result ->
        if (!current(token, stamp)) return@addOnSuccessListener
        val verdict = sharedAgeVerdict(result.ageLower(), result.ageUpper())
        when (verdict) {
          AgeVerdict.Allow -> openViewer()
          AgeVerdict.Retry -> showBlock(BlockReason.StoreUnreachable)
          is AgeVerdict.Block -> showBlock(verdict.reason)
        }
      }
      .addOnFailureListener { error ->
        if (!current(token, stamp)) return@addOnFailureListener
        onMandatoryFailure(token, attempt, error) { readPlayAges(token, attempt + 1) }
      }
  }

  private fun onMandatoryFailure(token: Int, attempt: Int, error: Exception, retry: () -> Unit) {
    val code = playCode(error)
    when (playMandatoryFailure(code)) {
      PlayFailure.Retry -> if (attempt >= 2) {
        showBlock(playBlockReason(code))
      } else {
        retryLater(token, attempt, retry)
      }
      PlayFailure.Allow, PlayFailure.Block -> showBlock(playBlockReason(code))
    }
  }

  private fun discoverAmazon(token: Int, attempt: Int) {
    val settled = AtomicBoolean(false)
    val signal = CancellationSignal()
    val giveUp = Runnable {
      if (!settled.compareAndSet(false, true)) return@Runnable
      signal.cancel()
      if (!still(token)) return@Runnable
      if (attempt >= 2) showBlock(BlockReason.StoreUnreachable)
      else retryLater(token, attempt) { discoverAmazon(token, attempt + 1) }
    }
    handler.postDelayed(giveUp, 5_000)
    thread(name = "age-gate", isDaemon = true) {
      val verdict = try {
        readAmazon(signal)
      } catch (_: Exception) {
        AgeVerdict.Retry
      }
      if (!settled.compareAndSet(false, true)) return@thread
      handler.removeCallbacks(giveUp)
      runOnUiThread {
        if (!still(token)) return@runOnUiThread
        when (verdict) {
          AgeVerdict.Allow -> openViewer()
          AgeVerdict.Retry -> if (attempt >= 2) {
            showBlock(BlockReason.StoreUnreachable)
          } else {
            retryLater(token, attempt) { discoverAmazon(token, attempt + 1) }
          }
          is AgeVerdict.Block -> showBlock(verdict.reason)
        }
      }
    }
  }

  private fun readAmazon(signal: CancellationSignal): AgeVerdict {
    val uri = Uri.parse("content://amzn_appstore/getUserAgeData")
    // No cursor, no row, or a query that throws: what Amazon says the API
    // gives before it returns live answers, and what a device without the
    // provider gives (amazonNotLive). Only a row is an answer about the user;
    // a row that cannot be read is retried (the caller's catch). Our own
    // timeout cancels the query too, but that thread has lost by then.
    val cursor = try {
      contentResolver.query(uri, null, null, null, null, signal)
    } catch (_: Exception) {
      return amazonNotLive
    } ?: return amazonNotLive
    cursor.use { rows ->
      if (!rows.moveToFirst()) return amazonNotLive
      return amazonVerdict(
        responseStatus = rows.text("responseStatus"),
        userStatus = rows.text("userStatus"),
        ageLower = rows.number("ageLower"),
        ageUpper = rows.number("ageUpper"),
      )
    }
  }

  private fun openViewer() {
    if (opened || isFinishing) return
    opened = true
    passedThisProcess = true
    startActivity(Intent(this, MainActivity::class.java))
    finish()
    overridePendingTransition(0, 0)
  }

  private fun showChecking() {
    progress.visibility = View.VISIBLE
    progress.contentDescription = getString(R.string.age_gate_checking)
    titleView.visibility = View.GONE
    messageView.visibility = View.VISIBLE
    messageView.setText(R.string.age_gate_checking)
    primary.visibility = View.GONE
    secondary.visibility = View.GONE
  }

  private fun showBlock(reason: BlockReason) {
    progress.visibility = View.GONE
    titleView.visibility = View.VISIBLE
    titleView.setText(R.string.age_gate_title)
    messageView.visibility = View.VISIBLE
    messageView.setText(when (reason) {
      BlockReason.Underage -> R.string.age_gate_under
      BlockReason.VerificationRequired -> R.string.age_gate_verify
      BlockReason.NotShared -> R.string.age_gate_not_shared
      BlockReason.Unconfirmed -> R.string.age_gate_unconfirmed
      BlockReason.PlayNeedsUpdate -> R.string.age_gate_update_play
      BlockReason.AppNeedsUpdate -> R.string.age_gate_update_app
      BlockReason.StoreUnreachable -> R.string.age_gate_unreachable
    })
    primary.visibility = View.VISIBLE
    when (reason) {
      BlockReason.VerificationRequired,
      BlockReason.PlayNeedsUpdate -> {
        primary.setText(R.string.age_gate_open_store)
        primary.setOnClickListener { openPlayStore(ownPage = false) }
        secondary.visibility = View.VISIBLE
        secondary.setText(R.string.age_gate_try_again)
        secondary.setOnClickListener { begin() }
      }
      BlockReason.AppNeedsUpdate -> {
        primary.setText(R.string.age_gate_open_store)
        primary.setOnClickListener { openPlayStore(ownPage = true) }
        secondary.visibility = View.VISIBLE
        secondary.setText(R.string.age_gate_close)
        secondary.setOnClickListener { finish() }
      }
      BlockReason.StoreUnreachable -> {
        primary.setText(R.string.age_gate_try_again)
        primary.setOnClickListener { begin() }
        secondary.visibility = View.VISIBLE
        secondary.setText(R.string.age_gate_close)
        secondary.setOnClickListener { finish() }
      }
      BlockReason.Underage,
      BlockReason.NotShared,
      BlockReason.Unconfirmed -> {
        primary.setText(R.string.age_gate_close)
        primary.setOnClickListener { finish() }
        secondary.visibility = View.GONE
      }
    }
    primary.requestFocus()
  }

  // The Play Store app: where Google sends the user to verify their age, and
  // where the store and Play services are updated. ownPage opens this app's
  // own listing instead, to update an age SDK Play no longer accepts. Coming
  // back checks again. Without the store app, its web page.
  private fun openPlayStore(ownPage: Boolean) {
    recheckOnResume = true
    val store = if (ownPage) {
      Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$packageName"))
        .setPackage("com.android.vending")
    } else {
      packageManager.getLaunchIntentForPackage("com.android.vending")
    }
    val web = Intent(
      Intent.ACTION_VIEW,
      Uri.parse(
        if (ownPage) "https://play.google.com/store/apps/details?id=$packageName"
        else "https://play.google.com/store"
      )
    )
    for (target in listOfNotNull(store, web)) {
      try {
        startActivity(target)
        return
      } catch (_: Exception) {
      }
    }
    recheckOnResume = false
  }

  private fun retryLater(token: Int, attempt: Int, again: () -> Unit) {
    handler.postDelayed({
      if (still(token)) again()
    }, 500L * (attempt + 1))
  }

  private fun still(token: Int): Boolean = token == generation && !isFinishing && !isDestroyed

  private fun current(token: Int, stamp: Int): Boolean = still(token) && stamp == step

  private fun playCode(error: Throwable): Int? {
    val found = error as? AgeSignalsException ?: error.cause as? AgeSignalsException
    return found?.getErrorCode()
  }

  private fun isLauncherIntent(source: Intent?): Boolean {
    if (source?.action != Intent.ACTION_MAIN) return false
    return source.hasCategory(Intent.CATEGORY_LAUNCHER) ||
      source.hasCategory(Intent.CATEGORY_LEANBACK_LAUNCHER)
  }
}

// Null means the column is absent or SQL NULL. A present empty string is
// kept, because Amazon uses that for "age verification does not apply".
private fun Cursor.text(column: String): String? {
  val index = getColumnIndex(column)
  if (index < 0 || isNull(index)) return null
  return getString(index)
}

private fun Cursor.number(column: String): Int? {
  val index = getColumnIndex(column)
  if (index < 0 || isNull(index)) return null
  return getInt(index)
}
