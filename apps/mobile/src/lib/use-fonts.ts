import {
  InterTight_400Regular,
  InterTight_500Medium,
  InterTight_600SemiBold,
  useFonts as useInterTight,
} from '@expo-google-fonts/inter-tight';
import {
  InstrumentSerif_400Regular_Italic,
  useFonts as useInstrumentSerif,
} from '@expo-google-fonts/instrument-serif';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  useFonts as useJetBrainsMono,
} from '@expo-google-fonts/jetbrains-mono';

/**
 * Loads the three brand font families. Returns `true` once all six
 * weights are resolved (Inter Tight 400/500/600, Instrument Serif
 * Italic 400, JetBrains Mono 400/500). Render the splash / placeholder
 * until this flips so we never flash system-fallback type.
 */
export function useBrandFonts(): boolean {
  const [tight] = useInterTight({
    InterTight_400Regular,
    InterTight_500Medium,
    InterTight_600SemiBold,
  });
  const [serif] = useInstrumentSerif({
    InstrumentSerif_400Regular_Italic,
  });
  const [mono] = useJetBrainsMono({
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });
  return tight && serif && mono;
}
