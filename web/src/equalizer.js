const STORAGE_KEY = "puffin.equalizer";
const FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const FLAT = Array(10).fill(0);
const BUILT_IN_PRESETS = {
  Flat: FLAT,
  Rock: [4, 3, 1, -1, -2, 1, 3, 4, 4, 3],
  Pop: [-1, 1, 3, 4, 2, -1, -1, 1, 2, 2],
  Classical: [3, 2, 1, 0, -1, -1, 0, 1, 2, 3],
  "Vocal Boost": [-2, -1, 1, 3, 4, 4, 3, 1, 0, -1],
};

function clampGain(value) {
  const gain = Number(value);
  return Number.isFinite(gain) ? Math.max(-12, Math.min(12, Math.round(gain))) : 0;
}

function readSavedState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      enabled: saved.enabled !== false,
      preamp: clampGain(saved.preamp),
      bands: Array.isArray(saved.bands) && saved.bands.length === FREQUENCIES.length
        ? saved.bands.map(clampGain)
        : [...FLAT],
      preset: typeof saved.preset === "string" ? saved.preset : "Flat",
      customPresets: Array.isArray(saved.customPresets)
        ? saved.customPresets.filter((preset) => typeof preset?.name === "string"
          && Array.isArray(preset.bands) && preset.bands.length === FREQUENCIES.length)
          .map((preset) => ({
            name: preset.name.slice(0, 40),
            preamp: clampGain(preset.preamp),
            bands: preset.bands.map(clampGain),
          }))
        : [],
    };
  } catch {
    return { enabled: true, preamp: 0, bands: [...FLAT], preset: "Flat", customPresets: [] };
  }
}

export function initializeEqualizer({ audioPlayer, videoPlayer }) {
  const openButton = document.querySelector("#player-equalizer-open");
  const dialog = document.querySelector("#equalizer-dialog");
  const closeButton = document.querySelector("#equalizer-close");
  const enabledInput = document.querySelector("#equalizer-enabled");
  const presetSelect = document.querySelector("#equalizer-preset");
  const bandInputs = [...dialog.querySelectorAll("[data-eq-band]")];
  const bandOutputs = [...dialog.querySelectorAll("[data-eq-value]")];
  const preampInput = document.querySelector("#equalizer-preamp");
  const preampOutput = document.querySelector("#equalizer-preamp-value");
  const presetNameInput = document.querySelector("#equalizer-custom-name");
  const savePresetButton = document.querySelector("#equalizer-save-preset");
  const deletePresetButton = document.querySelector("#equalizer-delete-preset");
  const status = document.querySelector("#equalizer-status");
  const state = readSavedState();
  let audioContext;
  let routes;

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      status.textContent = "Equalizer changes work for this session, but could not be saved on this device.";
      return false;
    }
  }

  function smooth(param, value) {
    if (!audioContext || !param) return;
    const now = audioContext.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, 0.025);
  }

  function updateAudioGraph() {
    if (!routes) return;
    const enabled = state.enabled;
    routes.forEach((route) => {
      route.filters.forEach((filter, index) => {
        smooth(filter.gain, enabled ? state.bands[index] : 0);
      });
      smooth(route.preamp.gain, enabled ? 10 ** (state.preamp / 20) : 1);
    });
  }

  function createAudioGraph() {
    if (routes) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("This browser does not support audio equalizer controls.");

    audioContext = new AudioContextClass();
    routes = [audioPlayer, videoPlayer].map((player) => {
      const source = audioContext.createMediaElementSource(player);
      const filters = FREQUENCIES.map((frequency) => {
        const filter = audioContext.createBiquadFilter();
        filter.type = "peaking";
        filter.frequency.value = frequency;
        filter.Q.value = 1;
        return filter;
      });
      const preamp = audioContext.createGain();
      source.connect(filters[0]);
      filters.forEach((filter, index) => {
        if (index < filters.length - 1) filter.connect(filters[index + 1]);
        else filter.connect(preamp);
      });
      preamp.connect(audioContext.destination);
      return { filters, preamp };
    });
    updateAudioGraph();
  }

  function findCustomPreset(name) {
    return state.customPresets.find((preset) => preset.name === name);
  }

  function refreshPresetOptions() {
    [...presetSelect.options].filter((option) => option.dataset.custom === "true").forEach((option) => option.remove());
    if (state.preset === "Custom" && !presetSelect.querySelector('[value="Custom"]')) {
      const option = document.createElement("option");
      option.value = "Custom";
      option.textContent = "Custom";
      presetSelect.append(option);
    }
    state.customPresets.forEach((preset) => {
      const option = document.createElement("option");
      option.value = preset.name;
      option.textContent = preset.name;
      option.dataset.custom = "true";
      presetSelect.append(option);
    });
    deletePresetButton.disabled = !findCustomPreset(presetSelect.value);
  }

  function render() {
    enabledInput.checked = state.enabled;
    bandInputs.forEach((input, index) => {
      input.value = String(state.bands[index]);
      bandOutputs[index].value = `${state.bands[index]} dB`;
      bandOutputs[index].textContent = `${state.bands[index]} dB`;
    });
    preampInput.value = String(state.preamp);
    preampOutput.value = `${state.preamp} dB`;
    preampOutput.textContent = `${state.preamp} dB`;
    refreshPresetOptions();
    if ([...presetSelect.options].some((option) => option.value === state.preset)) {
      presetSelect.value = state.preset;
    } else {
      presetSelect.value = "Flat";
      state.preset = "Flat";
    }
    updateAudioGraph();
  }

  function applyPreset(name) {
    const builtIn = BUILT_IN_PRESETS[name];
    const custom = findCustomPreset(name);
    if (builtIn) {
      state.bands = [...builtIn];
      state.preamp = -Math.max(0, ...builtIn);
    } else if (custom) {
      state.bands = [...custom.bands];
      state.preamp = custom.preamp;
    } else {
      return;
    }
    state.preset = name;
    presetNameInput.value = custom ? custom.name : "";
    status.textContent = name === "Flat" ? "Flat response selected." : `${name} preset selected with headroom for its boosted bands.`;
    render();
    persist();
  }

  openButton.addEventListener("click", async () => {
    try {
      createAudioGraph();
      await audioContext.resume();
      status.textContent = "Equalizer controls audio and video playback on this device.";
    } catch (error) {
      status.textContent = error.message || "Could not start the equalizer.";
    }
    render();
    openButton.setAttribute("aria-expanded", "true");
    dialog.showModal();
    closeButton.focus();
  });

  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => openButton.setAttribute("aria-expanded", "false"));
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("cancel", () => openButton.setAttribute("aria-expanded", "false"));
  dialog.addEventListener("close", () => openButton.focus());
  openButton.setAttribute("aria-haspopup", "dialog");
  openButton.setAttribute("aria-expanded", "false");

  enabledInput.addEventListener("change", () => {
    state.enabled = enabledInput.checked;
    updateAudioGraph();
    persist();
    status.textContent = state.enabled ? "Equalizer enabled." : "Equalizer bypassed.";
  });
  presetSelect.addEventListener("change", () => applyPreset(presetSelect.value));
  bandInputs.forEach((input, index) => {
    input.addEventListener("input", () => {
      state.bands[index] = clampGain(input.value);
      bandOutputs[index].value = `${state.bands[index]} dB`;
      bandOutputs[index].textContent = `${state.bands[index]} dB`;
      if (findCustomPreset(presetSelect.value)) {
        state.preset = "Custom";
        status.textContent = "Modified from the saved custom preset. Save it again to update it.";
      } else {
        state.preset = "Custom";
        status.textContent = "Custom curve. Save a name to keep it as a preset.";
      }
      if (presetSelect.value !== "Custom") {
        let customOption = presetSelect.querySelector('[value="Custom"]');
        if (!customOption) {
          customOption = document.createElement("option");
          customOption.value = "Custom";
          customOption.textContent = "Custom";
          presetSelect.append(customOption);
        }
        presetSelect.value = "Custom";
      }
      updateAudioGraph();
      persist();
    });
  });
  preampInput.addEventListener("input", () => {
    state.preamp = clampGain(preampInput.value);
    preampOutput.value = `${state.preamp} dB`;
    preampOutput.textContent = `${state.preamp} dB`;
    state.preset = "Custom";
    if (!presetSelect.querySelector('[value="Custom"]')) {
      const option = document.createElement("option");
      option.value = "Custom";
      option.textContent = "Custom";
      presetSelect.append(option);
    }
    presetSelect.value = "Custom";
    status.textContent = "Custom curve. Save a name to keep it as a preset.";
    updateAudioGraph();
    persist();
  });
  savePresetButton.addEventListener("click", () => {
    const name = presetNameInput.value.trim().replace(/\s+/g, " ");
    if (!name) {
      status.textContent = "Enter a name for this preset first.";
      presetNameInput.focus();
      return;
    }
    if (name.toLocaleLowerCase() === "custom" || Object.keys(BUILT_IN_PRESETS).some((presetName) => presetName.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      status.textContent = "Choose a name that is different from the built-in presets.";
      presetNameInput.focus();
      return;
    }
    const existing = state.customPresets.findIndex((preset) => preset.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    const preset = { name, preamp: state.preamp, bands: [...state.bands] };
    if (existing >= 0) state.customPresets[existing] = preset;
    else state.customPresets.push(preset);
    state.preset = name;
    render();
    persist();
    status.textContent = `${name} preset saved on this device.`;
  });
  deletePresetButton.addEventListener("click", () => {
    const preset = findCustomPreset(presetSelect.value);
    if (!preset) return;
    state.customPresets = state.customPresets.filter((candidate) => candidate !== preset);
    state.preset = "Flat";
    state.bands = [...FLAT];
    state.preamp = 0;
    presetNameInput.value = "";
    render();
    persist();
    status.textContent = `${preset.name} preset deleted.`;
  });

  render();
  return { frequencies: [...FREQUENCIES] };
}
