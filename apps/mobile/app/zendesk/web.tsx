import { useRouter, useLocalSearchParams } from 'expo-router';
import { ArrowLeft, RefreshCw } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { Button } from '@/components/ui/button';
import { IconChip } from '@/components/ui/row';
import { Body, Eyebrow } from '@/components/ui/text';
import { useTheme } from '@/lib/use-theme';

/**
 * Full-screen embedded Zendesk agent UI.
 *
 * The user logs in with their normal Zendesk credentials (SSO) inside the
 * WebView. `sharedCookiesEnabled` + `domStorageEnabled` keep the session
 * alive across visits so they only sign in once.
 *
 * This screen requires a NEW EAS build — react-native-webview is a native
 * module and cannot be delivered via OTA (Expo Updates).
 */
export default function ZendeskWebScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const { subdomain } = useLocalSearchParams<{ subdomain: string }>();

  const [loading, setLoading] = React.useState(true);
  const [hasError, setHasError] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);

  // Re-validate the subdomain param against the same DNS-label guard the server
  // enforces on write — the value is interpolated into the WebView host, so a
  // deep-link like ?subdomain=evil must not retarget it off zendesk.com. An
  // invalid value falls through to the "no subdomain set" guard message below.
  const trimmed = subdomain?.trim() ?? '';
  const uri = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(trimmed)
    ? `https://${trimmed}.zendesk.com/agent`
    : null;

  function handleRetry() {
    setHasError(false);
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={() => router.back()} />
          <Eyebrow style={styles.title}>Zendesk</Eyebrow>
          {/* Spacer to balance the back button */}
          <View style={styles.topbarRight} />
        </View>
      </SafeAreaView>

      {/* No subdomain guard */}
      {!uri ? (
        <View style={styles.center}>
          <Body muted size={14} style={styles.noSubdomainText}>
            No Zendesk subdomain set — set it on the web app first.
          </Body>
        </View>
      ) : (
        <View style={styles.webviewContainer}>
          {/* Loading overlay */}
          {loading && !hasError ? (
            <View style={[styles.overlay, { backgroundColor: c.paper }]}>
              <ActivityIndicator color={c.ink4} />
            </View>
          ) : null}

          {/* Error state */}
          {hasError ? (
            <View style={[styles.center, { backgroundColor: c.paper }]}>
              <Body muted size={14} style={styles.errorText}>
                Couldn't load Zendesk. Check your connection and try again.
              </Body>
              <View style={{ marginTop: 16, alignSelf: 'center' }}>
                <Button variant="outline" size="sm" onPress={handleRetry}>
                  <RefreshCw size={14} color={c.ink} style={{ marginRight: 6 }} />
                  Retry
                </Button>
              </View>
            </View>
          ) : (
            <WebView
              key={reloadKey}
              source={{ uri }}
              style={styles.webview}
              // SSO / auth
              javaScriptEnabled
              domStorageEnabled
              sharedCookiesEnabled
              thirdPartyCookiesEnabled
              incognito={false}
              // UX
              allowsBackForwardNavigationGestures
              onLoadStart={() => {
                setLoading(true);
                setHasError(false);
              }}
              onLoadEnd={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                setHasError(true);
              }}
            />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    flex: 1,
    textAlign: 'center',
  },
  topbarRight: {
    width: 36,
  },
  webviewContainer: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  noSubdomainText: {
    textAlign: 'center',
  },
  errorText: {
    textAlign: 'center',
  },
});
