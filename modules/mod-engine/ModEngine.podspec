Pod::Spec.new do |s|
  s.name           = 'ModEngine'
  s.version        = '0.1.0'
  s.summary        = 'Isolated QuickJS-ng engines that run mods for Herdr Mobile'
  s.description    = 'One QuickJS-ng runtime per mod copy, on a native thread of its own.'
  s.license        = 'MIT'
  s.author         = 'herdr-mobile'
  s.homepage       = 'https://github.com/Deeds67/herdr-mobile'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/Deeds67/herdr-mobile.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # The engine in cpp/ is shared with the Android build.
  s.source_files = 'ios/*.{swift,h}', 'cpp/*.{c,h}', 'cpp/quickjs/*.{c,h}'
  s.exclude_files = 'cpp/me_cli.c'
  s.public_header_files = 'ios/ModEngine.h'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    # QuickJS's own warnings are not ours to fix.
    'GCC_WARN_INHIBIT_ALL_WARNINGS' => 'YES',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) NDEBUG',
  }
end
