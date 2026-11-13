import { useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, PanResponder, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import ViewShot from 'react-native-view-shot';

export const C = {
  brand: '#0F6B4F',
  brandDark: '#0B3D2E',
  accent: '#F5B83D',
  ink: '#13201B',
  muted: '#5E6B66',
  line: '#E3E8E6',
  bg: '#F4F6F5',
  white: '#FFFFFF',
  red: '#C62828',
  amber: '#B26A00',
  green: '#1B7F4B',
  violet: '#6D28D9',
};

export function Button({ title, onPress, variant = 'primary', loading, disabled, style, small }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'accent'; loading?: boolean; disabled?: boolean; style?: ViewStyle; small?: boolean }): ReactNode {
  const bg = { primary: C.brand, secondary: C.white, danger: C.red, ghost: 'transparent', accent: C.accent }[variant];
  const fg = variant === 'secondary' || variant === 'ghost' ? C.ink : variant === 'accent' ? C.brandDark : C.white;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        s.btn,
        small && { paddingVertical: 9, paddingHorizontal: 12 },
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1, borderWidth: variant === 'secondary' ? 1 : 0, borderColor: C.line },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }, small && { fontSize: 14 }]}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }): ReactNode {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }): ReactNode {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor="#9AA5A0" {...props} style={[s.input, props.multiline && { minHeight: 80, textAlignVertical: 'top' }, props.style]} />
    </View>
  );
}

const TONES: Record<string, [string, string]> = {
  green: ['#E7F5EE', C.green], amber: ['#FFF4E0', C.amber], red: ['#FDECEC', C.red], gray: ['#EEF1F0', C.muted], violet: ['#F1EBFE', C.violet], blue: ['#E8F1FD', '#1D5FBF'],
};
const STATUS: Record<string, string> = { completed: 'green', arrived: 'blue', en_route: 'violet', in_progress: 'violet', pending: 'gray', failed: 'red', skipped: 'gray', dispatched: 'amber', scheduled: 'blue' };
export function Badge({ text, tone, status }: { text: string; tone?: string; status?: string }): ReactNode {
  const [bg, fg] = TONES[tone ?? STATUS[status ?? ''] ?? 'gray']!;
  return <Text style={[s.badge, { backgroundColor: bg, color: fg }]}>{text}</Text>;
}

export function H({ children, style }: { children: ReactNode; style?: object }): ReactNode {
  return <Text style={[{ fontSize: 18, fontWeight: '700', color: C.ink, marginBottom: 10 }, style]}>{children}</Text>;
}
export function Muted({ children, style }: { children: ReactNode; style?: object }): ReactNode {
  return <Text style={[{ fontSize: 13, color: C.muted }, style]}>{children}</Text>;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; color?: string }[]; onChange: (v: T) => void }): ReactNode {
  return (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} style={[s.seg, value === o.value && { backgroundColor: o.color ?? C.brand, borderColor: o.color ?? C.brand }]}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: value === o.value ? C.white : C.ink }}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Finger signature pad; `capture()` returns a PNG file URI for upload. */
export function SignaturePad({ padRef }: { padRef: React.MutableRefObject<{ capture: () => Promise<string | null>; clear: () => void } | null> }): ReactNode {
  const [paths, setPaths] = useState<string[]>([]);
  const cur = useRef('');
  const shot = useRef<{ capture?: () => Promise<string> } | null>(null);
  const [, force] = useState(0);
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        cur.current = `M${e.nativeEvent.locationX.toFixed(1)},${e.nativeEvent.locationY.toFixed(1)}`;
        force((x) => x + 1);
      },
      onPanResponderMove: (e) => {
        cur.current += ` L${e.nativeEvent.locationX.toFixed(1)},${e.nativeEvent.locationY.toFixed(1)}`;
        force((x) => x + 1);
      },
      onPanResponderRelease: () => {
        const p = cur.current;
        cur.current = '';
        setPaths((ps) => [...ps, p]);
      },
    }),
  ).current;
  padRef.current = {
    clear: () => setPaths([]),
    capture: async () => (paths.length ? ((await shot.current?.capture?.()) ?? null) : null),
  };
  return (
    <ViewShot ref={shot as never} options={{ format: 'png', quality: 1, result: 'tmpfile' }} style={s.sig}>
      <View style={{ flex: 1 }} {...responder.panHandlers}>
        <Svg width="100%" height="100%">
          {[...paths, cur.current].filter(Boolean).map((d, i) => <Path key={i} d={d} stroke={C.ink} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />)}
        </Svg>
      </View>
    </ViewShot>
  );
}

export const s = StyleSheet.create({
  btn: { paddingVertical: 13, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 16, fontWeight: '600' },
  card: { backgroundColor: C.white, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: C.line, marginBottom: 12 },
  label: { fontSize: 13, fontWeight: '600', color: C.muted, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16, color: C.ink, backgroundColor: C.white },
  badge: { fontSize: 12, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden', alignSelf: 'flex-start' },
  seg: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingVertical: 10, alignItems: 'center', backgroundColor: C.white },
  sig: { height: 170, borderWidth: 1, borderStyle: 'dashed', borderColor: '#AAB5B0', borderRadius: 12, backgroundColor: C.white, overflow: 'hidden' },
  screen: { flex: 1, backgroundColor: C.bg },
  row: { flexDirection: 'row', alignItems: 'center' },
});
