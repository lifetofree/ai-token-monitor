// mac/temp-sensor.c
// Reads CPU die temperature on Apple Silicon without root, via the private
// IOHIDEventSystemClient HID-event API (resolved at runtime with dlopen —
// no public header declares these symbols). This is the tradeoff issue #5's
// research documented: no-sudo is possible, but only through native code, so
// this file is compiled once (see mac/mac-monitor.js) rather than at every
// sample. Adapted from the technique in sebhildebrandt/macos-temperature-
// sensor's lib/src/temps.c (same call sequence, condensed to a single CLI
// that prints one averaged Celsius value for the daemon to parse).
//
// Prints a single float (Celsius) to stdout on success, exits non-zero with
// a message on stderr on failure (e.g. run on non-Apple-Silicon hardware).
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

typedef void* IOHIDEventSystemClientRef;
typedef void* IOHIDServiceClientRef;
typedef void* IOHIDEventRef;

#define kIOHIDEventTypeTemperature 15

static inline uint32_t IOHIDEventFieldBase(uint32_t type) { return (type << 16); }

typedef IOHIDEventSystemClientRef (*fn_ClientCreate)(CFAllocatorRef);
typedef CFArrayRef (*fn_CopyServices)(IOHIDEventSystemClientRef);
typedef CFTypeRef (*fn_CopyProperty)(IOHIDServiceClientRef, CFStringRef);
typedef IOHIDEventRef (*fn_CopyEvent)(IOHIDServiceClientRef, int32_t, uint64_t, uint32_t);
typedef double (*fn_GetFloatValue)(IOHIDEventRef, uint32_t);

static int has_prefix(const char* s, const char* prefix) {
  return strncmp(s, prefix, strlen(prefix)) == 0;
}

int main(void) {
  void* h = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_LAZY);
  if (!h) { fprintf(stderr, "dlopen IOKit failed\n"); return 100; }

  fn_ClientCreate    ClientCreate    = (fn_ClientCreate)dlsym(h, "IOHIDEventSystemClientCreate");
  fn_CopyServices    CopyServices    = (fn_CopyServices)dlsym(h, "IOHIDEventSystemClientCopyServices");
  fn_CopyProperty    CopyProperty    = (fn_CopyProperty)dlsym(h, "IOHIDServiceClientCopyProperty");
  fn_CopyEvent       CopyEvent       = (fn_CopyEvent)dlsym(h, "IOHIDServiceClientCopyEvent");
  fn_GetFloatValue   GetFloatValue   = (fn_GetFloatValue)dlsym(h, "IOHIDEventGetFloatValue");
  if (!ClientCreate || !CopyServices || !CopyProperty || !CopyEvent || !GetFloatValue) {
    fprintf(stderr, "dlsym failed to resolve HID symbols\n");
    return 101;
  }

  IOHIDEventSystemClientRef client = ClientCreate(kCFAllocatorDefault);
  if (!client) { fprintf(stderr, "IOHIDEventSystemClientCreate failed\n"); return 2; }

  CFArrayRef services = CopyServices(client);
  if (!services) { fprintf(stderr, "CopyServices failed\n"); CFRelease((CFTypeRef)client); return 3; }

  CFIndex n = CFArrayGetCount(services);
  double sum = 0.0;
  size_t cnt = 0;

  for (CFIndex i = 0; i < n; i++) {
    IOHIDServiceClientRef sc = (IOHIDServiceClientRef)CFArrayGetValueAtIndex(services, i);
    if (!sc) continue;

    CFTypeRef product = CopyProperty(sc, CFSTR("Product"));
    if (!product || CFGetTypeID(product) != CFStringGetTypeID()) { if (product) CFRelease(product); continue; }

    char name[128];
    Boolean ok = CFStringGetCString((CFStringRef)product, name, sizeof(name), kCFStringEncodingUTF8);
    CFRelease(product);
    if (!ok) continue;

    // CPU die-temperature sensors on Apple Silicon. Sensor naming is
    // undocumented and varies by chip/macOS generation — verified empirically
    // on this machine (macOS 26.5.2) via a debug dump of every HID service:
    // "PMU tdieN" is the CPU die temp (53-56C at idle, matches Activity
    // Monitor's ballpark), "PMU tdevN" reads lower and covers other
    // components, "gas gauge battery"/"NAND CH0 temp" are non-CPU. The
    // "pACC/eACC MTR Temp Sensor" names some reference implementations use
    // did not appear at all on this hardware.
    if (!has_prefix(name, "PMU tdie")) continue;

    IOHIDEventRef ev = CopyEvent(sc, kIOHIDEventTypeTemperature, 0, 0);
    if (!ev) continue;
    double t = GetFloatValue(ev, IOHIDEventFieldBase(kIOHIDEventTypeTemperature));
    CFRelease((CFTypeRef)ev);

    if (t < -20.0 || t > 130.0) continue; // plausibility filter
    sum += t;
    cnt++;
  }

  CFRelease(services);
  CFRelease((CFTypeRef)client);

  if (cnt == 0) { fprintf(stderr, "no temperature sensors found\n"); return 7; }

  printf("%.2f\n", sum / (double)cnt);
  return 0;
}
