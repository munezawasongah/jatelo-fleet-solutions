import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

/** Camera photo resized to 1600 px JPEG for slow networks. Null if cancelled or permission denied. */
export async function takePhoto(): Promise<string | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return null;
  const r = await ImagePicker.launchCameraAsync({ quality: 0.7, allowsEditing: false });
  if (r.canceled || !r.assets[0]) return null;
  // shrink for slow networks: 1600px long edge JPEG
  const m = await ImageManipulator.manipulateAsync(r.assets[0].uri, [{ resize: { width: 1600 } }], { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG });
  return m.uri;
}

