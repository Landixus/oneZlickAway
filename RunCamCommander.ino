/**
 * ZWIFT DUAL COMMANDER - FINAL PRODUCTION
 * Hardware: ESP32 D1 Mini
 * Belegung:
 * - Linkes Modul:  Pin 32 (Fahren & Menü)
 * - Rechtes Modul: Pin 33 (Kamera & Drone)
 * * Kalibriert auf User-Werte (Unten=0, Rechts=1500, Oben=2300, Links=2800, Mitte=3300)
 */

#include <BleKeyboard.h>

// --- KONFIGURATION ---
const bool CALIBRATION_MODE = false; // Jetzt bereit zum Fahren!

BleKeyboard bleKeyboard("BikeTerra Cockpit", "DIY", 100);

// PINS
const int PIN_LEFT_STICK = 32;
const int PIN_RIGHT_STICK = 33;

const int LONG_PRESS_MS = 500;   
const int IDLE_THRESHOLD = 3800; // Alles darüber ist "losgelassen"

// --- STATUS SPEICHER ---
struct StickState {
  int pin;
  unsigned long pressStartTime;
  bool isPressed;
  int currentFunction;
  bool longPressHandled;
};

StickState stickL = {PIN_LEFT_STICK, 0, false, 0, false};
StickState stickR = {PIN_RIGHT_STICK, 0, false, 0, false};

void setup() {
  Serial.begin(115200);
  analogReadResolution(12); // 0-4095
  
  pinMode(PIN_LEFT_STICK, INPUT);
  pinMode(PIN_RIGHT_STICK, INPUT);
  
  // CPU runtertakten um Strom zu sparen (80MHz reicht locker)
  setCpuFrequencyMhz(80);

  if (!CALIBRATION_MODE) {
    bleKeyboard.begin();
  }
  
  Serial.println("--- ZWIFT COCKPIT BEREIT ---");
}

// --- TASTE IDENTIFIZIEREN (Deine Messwerte) ---
int identifyButton(int val) {
  // UNTEN (Gemessen: 0) -> Bereich 0 bis 300
  if (val < 300) return 3;                  
  
  // RECHTS (Gemessen: ~1500) -> Bereich 1300 bis 1700
  if (val > 1300 && val < 1700) return 4;   
  
  // OBEN (Gemessen: ~2300) -> Bereich 2100 bis 2500
  if (val > 2100 && val < 2500) return 1;   
  
  // LINKS (Gemessen: ~2800) -> Bereich 2600 bis 3000
  if (val > 2600 && val < 3000) return 2;   
  
  // MITTE (Gemessen: ~3300) -> Bereich 3100 bis 3700
  if (val > 3100 && val < 3700) return 5;   
  
  return 0; // Keine Taste (Ruhezustand > 3800)
}

// --- HAUPTLOGIK ---
void processStick(StickState &stick, bool isSteeringStick) {
  
  // 1. Lesen & Glätten (Wichtig für stabile Werte)
  long valSum = 0;
  for(int i=0; i<4; i++) { valSum += analogRead(stick.pin); delay(1); }
  int val = valSum / 4;

  if (CALIBRATION_MODE) {
    if (val < IDLE_THRESHOLD) { Serial.println(val); delay(100); }
    return;
  }

  // 2. Button Identifizieren
  int btn = identifyButton(val);

  // A) FRISCH GEDRÜCKT
  if (btn != 0 && !stick.isPressed) {
    stick.isPressed = true;
    stick.pressStartTime = millis();
    stick.currentFunction = btn;
    stick.longPressHandled = false;

    // Sofort-Lenkung (Nur auf dem linken Stick bei Links/Rechts)
    if (isSteeringStick) {
      if (stick.currentFunction == 2) bleKeyboard.press(KEY_LEFT_ARROW);
      if (stick.currentFunction == 4) bleKeyboard.press(KEY_RIGHT_ARROW);
    }
  }

  // B) GEHALTEN
  else if (btn != 0 && stick.isPressed) {
    if (btn == stick.currentFunction) { 
      // Long Press Timer
      if (!stick.longPressHandled && (millis() - stick.pressStartTime > LONG_PRESS_MS)) {
        
        // Lenkung kurz unterbrechen für Longpress-Aktion
        if (isSteeringStick && (stick.currentFunction == 2 || stick.currentFunction == 4)) {
           bleKeyboard.release(KEY_LEFT_ARROW);
           bleKeyboard.release(KEY_RIGHT_ARROW);
        }

        // Aktion ausführen (LANG)
        performAction(stick.pin, stick.currentFunction, true); 
        stick.longPressHandled = true;
      }
    }
  }

  // C) LOSGELASSEN
  else if (btn == 0 && stick.isPressed) {
    stick.isPressed = false;

    // Lenkung beenden
    if (isSteeringStick) {
       bleKeyboard.release(KEY_LEFT_ARROW);
       bleKeyboard.release(KEY_RIGHT_ARROW);
    }

    // Short Press ausführen (nur wenn Longpress nicht aktiv war)
    if (!stick.longPressHandled) {
      performAction(stick.pin, stick.currentFunction, false); // false = KURZ
    }
    stick.currentFunction = 0;
  }
}

// --- TASTEN BELEGUNG ---
// btn IDs: 1=Oben, 2=Links, 3=Unten, 4=Rechts, 5=Mitte
void performAction(int pin, int btn, bool isLong) {
  
  // --- LINKES MODUL (Pin 32) - FAHREN & MENÜ ---
  if (pin == PIN_LEFT_STICK) {
    if (!isLong) { // KURZ
      switch(btn) {
        case 1: bleKeyboard.write('w'); break;        // Oben: Watt/Menü hoch
        case 3: bleKeyboard.write('s'); break;        // Unten: Bremse/Zurück
        case 5: bleKeyboard.write(KEY_RETURN); break; // Mitte: Enter
        // Links(2)/Rechts(4) sind Lenkung (passiert automatisch oben)
      }
    } else { // LANG
      switch(btn) {
        case 1: sendKey(KEY_LEFT_SHIFT, ' '); break; // Oben: PowerUp!
        case 2: bleKeyboard.write(KEY_F3); break;    // Links: Winken
        case 3: sendKey(KEY_LEFT_SHIFT, 'e'); break; // Unten: Workout Editor
        case 4: bleKeyboard.write(KEY_F4); break;    // Rechts: Ride On!
        case 5: bleKeyboard.write(KEY_ESC); break;   // Mitte: ESC
      }
    }
  }

  // --- RECHTES MODUL (Pin 33) - KAMERA & DRONE ---
  if (pin == PIN_RIGHT_STICK) {
    if (!isLong) { // KURZ
      switch(btn) {
        case 1: bleKeyboard.write(KEY_PAGE_UP); break;   // Oben: Intensität +
        case 2: bleKeyboard.write('4'); break;           // Links: Ansicht Seite
        case 3: bleKeyboard.write(KEY_PAGE_DOWN); break; // Unten: Intensität -
        case 4: bleKeyboard.write('6'); break;           // Rechts: Ansicht Hinten
        case 5: bleKeyboard.write(KEY_TAB); break;       // Mitte: Skip Block
      }
    } else { // LANG
      switch(btn) {
        case 1: bleKeyboard.write('1'); break;           // Oben: Ansicht Standard
        case 2: bleKeyboard.write('0'); break;           // Links: Ansicht Drone
        case 3: bleKeyboard.write('9'); break;           // Unten: Ansicht Vogel
        case 4: bleKeyboard.write('5'); break;           // Rechts: Ansicht 5
        case 5: bleKeyboard.write(KEY_F10); break;       // Mitte: Screenshot
      }
    }
  }
}

// Hilfsfunktion für Tastenkombis
void sendKey(uint8_t modifier, uint8_t key) {
  bleKeyboard.press(modifier);
  bleKeyboard.write(key);
  bleKeyboard.releaseAll();
}

void loop() {
  if (bleKeyboard.isConnected()) {
    processStick(stickL, true);  // Links = Lenkung aktiv
    processStick(stickR, false); // Rechts = Keine Lenkung
  }
  delay(10);
}