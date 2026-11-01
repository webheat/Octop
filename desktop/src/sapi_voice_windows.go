//go:build windows

// Local narration for the free tier.
//
// The paid tier receives pre-rendered clips from the server. The free tier
// synthesises them here with the Windows Speech API (SAPI5), which is
// offline, free and safe for commercial use — unlike the Edge "read aloud"
// endpoint, whose terms only allow personal use.
//
// The desktop shell is the only place this can run: the server is Linux and
// the browser has no way to hand an audio file to the renderer.

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

// ProgIDs of the SAPI objects used here. They are stable Windows constants.
const (
	progIDSpVoice      = "SAPI.SpVoice"
	progIDSpFileStream = "SAPI.SpFileStream"
)

// SPF_DEFAULT — speak the text without queuing it.
const spfDefault = 0

// SSFMCreateForWrite — open the capture file for writing.
const ssfmCreateForWrite = 3

// DISPATCH_PROPERTYPUT_REF — set a property by reference.
//
// SAPI's own type library marks the settable properties (“Voice“,
// “AudioOutputStream“) with INVKIND_PROPERTYPUTREF, and the plain
// PROPERTYPUT flavour is rejected with "member not found".
const dispatchPropertyPutRef = 8

// Display ids of the SAPI voice properties (from sapi.idl).
const (
	dispidVoice             = 2
	dispidAudioOutputStream = 4
)

// sapiVoice wraps ISpVoice.
type sapiVoice struct {
	voice *ole.IDispatch
}

// sapiStream wraps ISpFileStream.
type sapiStream struct {
	stream *ole.IDispatch
}

// newSAPIObjects creates the voice and the capture stream.
//
// The caller must call the returned cleanup function exactly once.
func newSAPIObjects() (*sapiVoice, *sapiStream, func(), error) {
	// COM has to be initialised on this thread first. S_FALSE means it was
	// already initialised (by the Wails runtime), which is fine — in that
	// case the matching uninitialise must not run.
	initialised := false
	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err == nil {
		initialised = true
	}
	voiceUnknown, err := oleutil.CreateObject(progIDSpVoice)
	if err != nil {
		if initialised {
			ole.CoUninitialize()
		}
		return nil, nil, nil, fmt.Errorf("create voice: %w", err)
	}
	voice, err := voiceUnknown.QueryInterface(ole.IID_IDispatch)
	voiceUnknown.Release()
	if err != nil {
		if initialised {
			ole.CoUninitialize()
		}
		return nil, nil, nil, fmt.Errorf("query voice: %w", err)
	}
	streamUnknown, err := oleutil.CreateObject(progIDSpFileStream)
	if err != nil {
		voice.Release()
		if initialised {
			ole.CoUninitialize()
		}
		return nil, nil, nil, fmt.Errorf("create file stream: %w", err)
	}
	stream, err := streamUnknown.QueryInterface(ole.IID_IDispatch)
	streamUnknown.Release()
	if err != nil {
		voice.Release()
		if initialised {
			ole.CoUninitialize()
		}
		return nil, nil, nil, fmt.Errorf("query file stream: %w", err)
	}
	cleanup := func() {
		stream.Release()
		voice.Release()
		if initialised {
			ole.CoUninitialize()
		}
	}
	return &sapiVoice{voice: voice}, &sapiStream{stream: stream}, cleanup, nil
}

// voiceTokens returns the voice collection as a dispatch.
func (v *sapiVoice) voiceTokens() (*ole.IDispatch, error) {
	tokens, err := v.voice.CallMethod("GetVoices")
	if err != nil {
		return nil, err
	}
	return tokens.ToIDispatch(), nil
}

// listSAPIVoices returns the descriptions of the installed voices.
//
// The voice collection exposes “Item“ but not “Count“ through IDispatch,
// so the list is built by probing indices until “Item“ stops resolving.
func listSAPIVoices(target ...any) []string {
	var voice *ole.IDispatch
	if len(target) > 0 {
		voice, _ = target[0].(*ole.IDispatch)
	}
	if voice == nil {
		return nil
	}
	collection, err := voiceTokensOf(voice)
	if err != nil {
		return nil
	}
	defer collection.Release()
	var names []string
	for index := int32(0); index < 32; index++ {
		itemV, err := collection.CallMethod("Item", index)
		if err != nil || itemV == nil {
			break
		}
		item := itemV.ToIDispatch()
		if item == nil {
			break
		}
		descV, err := item.CallMethod("GetDescription")
		item.Release()
		if err != nil || descV == nil {
			break
		}
		if desc, ok := descV.Value().(string); ok && desc != "" {
			names = append(names, desc)
		}
	}
	return names
}

// voiceTokensOf returns the voice collection of a voice dispatch.
func voiceTokensOf(voice *ole.IDispatch) (*ole.IDispatch, error) {
	tokens, err := voice.CallMethod("GetVoices")
	if err != nil {
		return nil, fmt.Errorf("GetVoices: %w", err)
	}
	collection := tokens.ToIDispatch()
	if collection == nil {
		return nil, fmt.Errorf("GetVoices returned no collection")
	}
	return collection, nil
}

// selectChineseVoice points the voice at a Chinese desktop voice when one is
// installed, falling back to the first available voice.
func (v *sapiVoice) selectChineseVoice() (string, error) {
	names := listSAPIVoices(v.voice)
	if len(names) == 0 {
		return "", fmt.Errorf("no speech voice installed")
	}
	chosen := ""
	for _, name := range names {
		lower := strings.ToLower(name)
		if strings.Contains(lower, "chinese") ||
			strings.Contains(name, "Huihui") ||
			strings.Contains(name, "Yaoyao") ||
			strings.Contains(name, "Kangkang") {
			chosen = name
			break
		}
	}
	if chosen == "" {
		chosen = names[0]
	}
	collection, err := voiceTokensOf(v.voice)
	if err != nil {
		return chosen, err
	}
	defer collection.Release()
	for i := int32(0); i < 32; i++ {
		itemV, err := collection.CallMethod("Item", i)
		if err != nil {
			break
		}
		item := itemV.ToIDispatch()
		if item == nil {
			break
		}
		descV, err := item.CallMethod("GetDescription")
		if err != nil {
			item.Release()
			break
		}
		desc, _ := descV.Value().(string)
		if desc != chosen {
			item.Release()
			continue
		}
		// ``Voice`` is a settable property; SAPI only accepts the
		// PROPERTYPUT_REF flavour for it.
		if _, err := v.voice.Invoke(dispidVoice, dispatchPropertyPutRef, itemV); err != nil {
			item.Release()
			return chosen, fmt.Errorf("set voice: %w", err)
		}
		item.Release()
		return chosen, nil
	}
	return chosen, nil
}

// open prepares the capture stream for a WAV file.
//
// SAPI writes the RIFF header itself, so the file needs no post-processing.
func (s *sapiStream) open(path string) error {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	if _, err := s.stream.CallMethod("Open", path, ssfmCreateForWrite); err != nil {
		return fmt.Errorf("open wav: %w", err)
	}
	return nil
}

// close finalises the WAV header.
func (s *sapiStream) close() error {
	if _, err := s.stream.CallMethod("Close"); err != nil {
		return err
	}
	return nil
}

// synthesizeToWav renders one line into a WAV file and returns the voice name.
func synthesizeToWav(text, outPath string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("empty narration")
	}
	voice, stream, cleanup, err := newSAPIObjects()
	if err != nil {
		return "", err
	}
	defer cleanup()
	name, err := voice.selectChineseVoice()
	if err != nil {
		return "", fmt.Errorf("select voice: %w", err)
	}
	if err := stream.open(outPath); err != nil {
		return name, err
	}
	// ``AudioOutputStream`` redirects the voice into the capture file; it is
	// a settable property that only accepts the PROPERTYPUT_REF flavour.
	if _, err := voice.voice.Invoke(dispidAudioOutputStream, dispatchPropertyPutRef, stream.stream); err != nil {
		_ = stream.close()
		return name, fmt.Errorf("bind audio stream: %w", err)
	}
	if _, err := voice.voice.CallMethod("Speak", text, spfDefault); err != nil {
		_ = stream.close()
		return name, fmt.Errorf("speak: %w", err)
	}
	if err := stream.close(); err != nil {
		return name, err
	}
	info, err := os.Stat(outPath)
	if err != nil || info.Size() == 0 {
		return name, fmt.Errorf("no audio produced")
	}
	return name, nil
}
