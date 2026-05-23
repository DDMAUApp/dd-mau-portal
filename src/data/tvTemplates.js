// tvTemplates — starter configurations for the Menu Screens
// "Templates" picker.
//
// Andrew 2026-05-23. Each entry is a partial tv_config payload + a
// description shown in the gallery. Picking a template creates a
// new /tv_configs/{tvId} doc pre-populated with the template's
// payload (plus the admin's chosen label + location), then jumps
// into the existing TvConfigsEditor so the admin can fine-tune.
// Same flow as the digital-signage SaaS pattern (Yodeck +
// OptiSigns + Raydiant all do "pick a template, customize, ship").
//
// Templates are intentionally MINIMAL — they set the mode and the
// shape of the config, not the content. Photos, prices, hit-zones,
// daypart hours all live in the editor where the admin actually
// configures them. The template just removes the "what kind of
// screen am I building?" decision.
//
// Adding a new template:
//   • Pick an `id` (used internally; not surfaced)
//   • Pick an `icon` emoji for the gallery
//   • Write a 1-sentence description
//   • Set `labelPrefix` for the auto-generated tvId/label suggestion
//   • Build the `payload` — a partial tv_config matching the schema
//     in src/data/tvConfigs.js. Don't set `label` / `location` /
//     `tvId` here — those come from the modal.

import { MODES } from './tvConfigs';

export const TV_TEMPLATES = Object.freeze([
    {
        id: 'food_menu',
        icon: '🍜',
        name: 'Food Menu Board',
        nameEs: 'Tablero de comida',
        description: 'Classic 3-column dense food menu with prices and the live 86 list overlay. Best for the main wall behind the counter.',
        descriptionEs: 'Menú de comida denso de 3 columnas con precios y el 86 en vivo. Ideal para la pared principal.',
        labelPrefix: 'Food',
        payload: {
            mode: MODES.MENU,
            layout: 'dense',
            showPhotos: false,
            // includeCategories left null → all categories. Editor
            // lets admin narrow down to "Pho, Bowls, Bun" if they
            // want to drop drinks/sides from this screen.
            includeCategories: null,
        },
    },
    {
        id: 'drinks',
        icon: '🧋',
        name: 'Drinks Board',
        nameEs: 'Tablero de bebidas',
        description: 'Same dense layout, narrowed to drink categories. Best for the bar area or a boba-specific screen.',
        descriptionEs: 'Mismo diseño denso, limitado a categorías de bebidas. Ideal para el bar o pantalla de bobas.',
        labelPrefix: 'Drinks',
        payload: {
            mode: MODES.MENU,
            layout: 'dense',
            showPhotos: false,
            // Pre-narrow to typical drink categories. Editor lets
            // admin add/remove based on the actual MENU_DATA shape.
            includeCategories: ['Drinks', 'Boba', 'Tea', 'Coffee'],
        },
    },
    {
        id: 'specials_spotlight',
        icon: '⭐',
        name: 'Today\'s Specials',
        nameEs: 'Especiales del día',
        description: 'Spotlight layout — one hero category large on the left, the rest shrunk on the right. Set the spotlight category to "Specials" in the editor.',
        descriptionEs: 'Diseño con foco — una categoría destacada a la izquierda, el resto compactado a la derecha. Configura la categoría destacada en el editor.',
        labelPrefix: 'Specials',
        payload: {
            mode: MODES.MENU,
            layout: 'spotlight',
            showPhotos: true,
            spotlightCategory: null, // admin sets this in the editor
        },
    },
    {
        id: 'combos_rotate',
        icon: '🍱',
        name: 'Combo Board',
        nameEs: 'Tablero de combos',
        description: 'Rotating layout that cycles through categories every 8 seconds — good for showing combos one at a time on a single screen.',
        descriptionEs: 'Diseño rotativo que cicla cada 8 segundos — bueno para mostrar combos uno por uno.',
        labelPrefix: 'Combos',
        payload: {
            mode: MODES.MENU,
            layout: 'rotate',
            showPhotos: true,
            rotateSeconds: 8,
        },
    },
    {
        id: 'photo_slideshow',
        icon: '📸',
        name: 'Photo Slideshow',
        nameEs: 'Carrusel de fotos',
        description: 'Full-bleed image rotation. Upload food shots in the editor; the screen rotates through them every 12 seconds with a smooth fade.',
        descriptionEs: 'Imágenes a pantalla completa. Sube fotos en el editor; rota cada 12 segundos.',
        labelPrefix: 'Photos',
        payload: {
            mode: MODES.IMAGE,
            imageUrls: [],         // admin uploads in the editor
            imageRotateSeconds: 12,
            imageHitZones: [],
        },
    },
    {
        id: 'promo_strip',
        icon: '📣',
        name: 'Promo Screen',
        nameEs: 'Pantalla de promo',
        description: 'Image mode plus a scrolling promo strip at the bottom — for happy hour callouts, online-order links, holiday hours.',
        descriptionEs: 'Modo imagen con texto promocional desplazándose abajo — para happy hour, pedidos en línea, horarios festivos.',
        labelPrefix: 'Promo',
        payload: {
            mode: MODES.IMAGE,
            imageUrls: [],
            imageRotateSeconds: 12,
            imageHitZones: [],
            promoStrip: {
                enabled: true,
                position: 'bottom',
                textEn: '🎉 Happy Hour 3–5pm — half off boba teas',
                textEs: '🎉 Happy Hour 3–5pm — bobas al 50% de descuento',
                style: 'amber',
                speed: 80,
            },
        },
    },
    {
        id: 'qr_order',
        icon: '📱',
        name: 'QR Order Online',
        nameEs: 'QR para pedir',
        description: 'Image mode with a large QR placeholder. After saving, use the hit-zone editor to draw a QR over the right area and link it to your online-order URL.',
        descriptionEs: 'Modo imagen con marcador para QR. Después de guardar, dibuja una zona QR en el editor de hit-zones.',
        labelPrefix: 'Order',
        payload: {
            mode: MODES.IMAGE,
            imageUrls: [],
            imageRotateSeconds: 30,
            imageHitZones: [],
        },
    },
    {
        id: 'split_70_30',
        icon: '⫴',
        name: 'Menu + Photos (70/30)',
        nameEs: 'Menú + Fotos (70/30)',
        description: 'Split layout — your menu PDF/JPEG fills 70% on the left, a rotating photo carousel fills 30% on the right. The "Raydiant look".',
        descriptionEs: 'Diseño dividido — el menú a la izquierda (70%), carrusel de fotos a la derecha (30%).',
        labelPrefix: 'Split',
        payload: {
            mode: MODES.SPLIT,
            split: {
                leftImageUrls: [],
                leftRotateSeconds: 12,
                rightImageUrls: [],
                rightRotateSeconds: 8,
                leftWidthPct: 70,
            },
            imageHitZones: [],
        },
    },
]);

export function getTemplateById(id) {
    return TV_TEMPLATES.find(t => t.id === id) || null;
}
