import QRCode from 'qrcode';

export function paymentQrDataUrl(uri) {
  const options = { errorCorrectionLevel: 'M', margin: 4, color: { dark: '#17211b', light: '#ffffff' } };
  // Preserve a four-module quiet zone and whole pixels per module. Longer
  // requests grow instead of packing an increasingly dense code into 280px.
  const modules = QRCode.create(uri, options).modules.size + options.margin * 2;
  const width = modules * Math.max(4, Math.ceil(280 / modules));
  return QRCode.toDataURL(uri, { ...options, width });
}
