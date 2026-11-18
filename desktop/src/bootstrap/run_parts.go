package bootstrap

import (
	"fmt"
	"sort"
)

// RunParts installs exactly the parts named in partIDs and ignores the rest of
// the manifest. It is the on-demand counterpart of Run: Run installs every
// required part and skips the optional ones, RunParts installs what a feature
// asked for, whether the manifest marks it required or not.
//
// The run shares the cache directory and state.json with Run, so an archive a
// previous run downloaded is reused instead of fetched again. Parts are
// installed in manifest order, which keeps the merge-mode contract intact when
// partIDs includes the root part (the root part has to come first because its
// Extract empties the runtime root).
//
// RunParts changes no existing behaviour: Run keeps its "required parts only"
// semantics, and this function is only reached by a caller that names parts.
func RunParts(opts Options, partIDs []string) error {
	wanted := make(map[string]bool, len(partIDs))
	for _, id := range partIDs {
		if id != "" {
			wanted[id] = true
		}
	}
	if len(wanted) == 0 {
		return fmt.Errorf("bootstrap: no part ids were given")
	}

	selected := make([]Part, 0, len(wanted))
	for _, part := range opts.Manifest.Parts {
		if !wanted[part.ID] {
			continue
		}
		delete(wanted, part.ID)
		// Run skips every part that is not required. The caller named this one,
		// so install it regardless of how the manifest classifies it.
		part.Required = true
		selected = append(selected, part)
	}
	if len(wanted) > 0 {
		missing := make([]string, 0, len(wanted))
		for id := range wanted {
			missing = append(missing, id)
		}
		sort.Strings(missing)
		return fmt.Errorf("bootstrap: the manifest does not list parts %v", missing)
	}
	if err := rejectSharedTargets(selected); err != nil {
		return err
	}

	opts.Manifest = Manifest{
		Version:  opts.Manifest.Version,
		Platform: opts.Manifest.Platform,
		Parts:    selected,
	}
	return Run(opts)
}

// rejectSharedTargets refuses a selection in which two parts unpack into the
// same directory. Extract empties its destination before unpacking, so the
// second part would silently delete the first one's files. Distinct targets
// per part (for example "packages/_parts/<id>") are the contract.
func rejectSharedTargets(parts []Part) error {
	seen := make(map[string]string, len(parts))
	for _, part := range parts {
		if part.Target == "" {
			// The root part is covered by validateParts (at most one root, and
			// in merge mode it must come first).
			continue
		}
		if other, ok := seen[part.Target]; ok {
			return fmt.Errorf("bootstrap: parts %q and %q unpack into the same target %q", other, part.ID, part.Target)
		}
		seen[part.Target] = part.ID
	}
	return nil
}
