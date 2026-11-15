// Command mkicon 生成 LANShare 的网页图标与 Windows 可执行文件图标资源。
//
// 图标取自顶栏 .logo：#2563eb 圆角方块 + 白色 "LS" 字形。SVG、ICO、PNG 与
// .syso 全部由本文件里的 glyph / corner / blue 三个常量派生，改图标只改这里。
//
// 在项目根目录执行：go run ./tools/mkicon（等价于 go generate ./...）。
// 生成物需要提交：Go 在 GOOS=windows 时会自动链接带 _windows_* 后缀的 .syso，
// 其它平台构建会忽略它们。
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"
)

const (
	unit        = 64.0 // 设计坐标系边长
	corner      = 19.0 // 圆角半径；页面 .logo 为 30px / 9px
	supersample = 4    // 超采样倍数，用于抗锯齿
)

var (
	blue  = color.RGBA{0x25, 0x63, 0xeb, 0xff} // style.css --primary
	white = color.RGBA{0xff, 0xff, 0xff, 0xff}
)

type box struct{ x, y, w, h float64 }

// glyph 是 "LS" 的矩形笔画，SVG 与位图共用同一份定义。
var glyph = []box{
	{14, 18, 7, 29}, {14, 40, 16, 7}, // L
	{36, 18, 16, 7}, {36, 18, 7, 15}, // S：上横、左上竖
	{36, 29, 16, 7}, {45, 29, 7, 18}, {36, 40, 16, 7}, // S：中横、右下竖、下横
}

var le = binary.LittleEndian

func inGlyph(x, y float64) bool {
	for _, g := range glyph {
		if x >= g.x && x < g.x+g.w && y >= g.y && y < g.y+g.h {
			return true
		}
	}
	return false
}

func inRoundRect(x, y float64) bool {
	qx := math.Abs(x-unit/2) - (unit/2 - corner)
	qy := math.Abs(y-unit/2) - (unit/2 - corner)
	d := math.Hypot(math.Max(qx, 0), math.Max(qy, 0)) + math.Min(math.Max(qx, qy), 0) - corner
	return d <= 0
}

// render 先按 supersample 倍分辨率绘制，再盒式降采样。opaque=true 时铺满背景，
// 用于 iOS 的 apple-touch-icon（透明区域在 iOS 上会变黑）。
func render(size int, opaque bool) *image.RGBA {
	n := size * supersample
	scale := float64(n) / unit
	hi := image.NewRGBA(image.Rect(0, 0, n, n))
	for py := 0; py < n; py++ {
		for px := 0; px < n; px++ {
			x, y := (float64(px)+0.5)/scale, (float64(py)+0.5)/scale
			if !opaque && !inRoundRect(x, y) {
				continue
			}
			c := blue
			if inGlyph(x, y) {
				c = white
			}
			hi.SetRGBA(px, py, c)
		}
	}
	out := image.NewRGBA(image.Rect(0, 0, size, size))
	div := float64(supersample * supersample)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var r, g, b, a float64
			for dy := 0; dy < supersample; dy++ {
				for dx := 0; dx < supersample; dx++ {
					c := hi.RGBAAt(x*supersample+dx, y*supersample+dy)
					r += float64(c.R)
					g += float64(c.G)
					b += float64(c.B)
					a += float64(c.A)
				}
			}
			out.SetRGBA(x, y, color.RGBA{
				R: uint8(r/div + 0.5), G: uint8(g/div + 0.5),
				B: uint8(b/div + 0.5), A: uint8(a/div + 0.5),
			})
		}
	}
	return out
}

// dib 输出 32bpp BGRA 图标位图：BITMAPINFOHEADER + 自下而上的像素 + AND 掩码。
// image.RGBA 存的是预乘 alpha，写入前还原为直通 alpha。
func dib(img *image.RGBA) []byte {
	size := img.Bounds().Dx()
	maskRow := ((size + 31) / 32) * 4
	pixels, mask := size*size*4, maskRow*size
	buf := make([]byte, 40+pixels+mask)
	le.PutUint32(buf[0:], 40)
	le.PutUint32(buf[4:], uint32(size))
	le.PutUint32(buf[8:], uint32(size*2)) // XOR + AND
	le.PutUint16(buf[12:], 1)
	le.PutUint16(buf[14:], 32)
	le.PutUint32(buf[16:], 0) // BI_RGB
	le.PutUint32(buf[20:], uint32(pixels+mask))
	p := 40
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			c := img.RGBAAt(x, size-1-y)
			a := int(c.A)
			straight := func(v uint8) byte {
				if a == 0 {
					return 0
				}
				n := int(v) * 255 / a
				if n > 255 {
					n = 255
				}
				return byte(n)
			}
			buf[p], buf[p+1], buf[p+2], buf[p+3] = straight(c.B), straight(c.G), straight(c.R), byte(a)
			p += 4
		}
	}
	// AND 掩码全 0：32bpp 图标由 alpha 通道决定透明。
	return buf
}

type icon struct {
	size int
	data []byte
}

func iconByte(size int) byte {
	if size >= 256 {
		return 0 // ICO / GRPICON 里 0 表示 256
	}
	return byte(size)
}

func writeICO(path string, icons []icon) error {
	var b bytes.Buffer
	head := make([]byte, 6)
	le.PutUint16(head[2:], 1)
	le.PutUint16(head[4:], uint16(len(icons)))
	b.Write(head)
	off := 6 + 16*len(icons)
	for _, ic := range icons {
		e := make([]byte, 16)
		e[0], e[1] = iconByte(ic.size), iconByte(ic.size)
		le.PutUint16(e[4:], 1)
		le.PutUint16(e[6:], 32)
		le.PutUint32(e[8:], uint32(len(ic.data)))
		le.PutUint32(e[12:], uint32(off))
		b.Write(e)
		off += len(ic.data)
	}
	for _, ic := range icons {
		b.Write(ic.data)
	}
	return os.WriteFile(path, b.Bytes(), 0o644)
}

func writePNG(path string, img *image.RGBA) error {
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		return err
	}
	return os.WriteFile(path, b.Bytes(), 0o644)
}

func svg() string {
	var b strings.Builder
	b.WriteString("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\">\n")
	fmt.Fprintf(&b, "  <rect width=\"64\" height=\"64\" rx=\"%.0f\" fill=\"#2563eb\"/>\n", corner)
	b.WriteString("  <g fill=\"#fff\">\n")
	for _, g := range glyph {
		fmt.Fprintf(&b, "    <rect x=\"%.0f\" y=\"%.0f\" width=\"%.0f\" height=\"%.0f\"/>\n", g.x, g.y, g.w, g.h)
	}
	b.WriteString("  </g>\n</svg>\n")
	return b.String()
}

// ---- Windows 资源（.syso）----

type dirEntry struct {
	id     uint32
	offset uint32
	subdir bool
}

func directory(entries []dirEntry) []byte {
	b := make([]byte, 16+8*len(entries))
	le.PutUint16(b[14:], uint16(len(entries))) // NumberOfIdEntries，全部用数字 ID
	for i, e := range entries {
		p := 16 + 8*i
		le.PutUint32(b[p:], e.id)
		off := e.offset
		if e.subdir {
			off |= 0x80000000
		}
		le.PutUint32(b[p+4:], off)
	}
	return b
}

func align4(n int) int { return (n + 3) &^ 3 }

// buildResource 返回 .rsrc 段内容与需要重定位的偏移列表。
// 只有 IMAGE_RESOURCE_DATA_ENTRY.OffsetToData 是 RVA，需要 ADDR32NB 重定位；
// 目录项里的偏移是相对资源目录起点的，不需要重定位。
func buildResource(icons []icon) ([]byte, []uint32) {
	n := len(icons)
	group := make([]byte, 6+14*n)
	le.PutUint16(group[2:], 1)
	le.PutUint16(group[4:], uint16(n))
	for i, ic := range icons {
		e := group[6+14*i : 6+14*(i+1)]
		e[0], e[1] = iconByte(ic.size), iconByte(ic.size)
		le.PutUint16(e[4:], 1)
		le.PutUint16(e[6:], 32)
		le.PutUint32(e[8:], uint32(len(ic.data)))
		le.PutUint16(e[12:], uint16(i+1))
	}

	const (
		oTop       = 0
		oIconType  = 16 + 8*2
		oGroupLang = 24
	)
	oGroupType := oIconType + 16 + 8*n
	oLang := oGroupType + oGroupLang
	oDataEntry := oLang + 24*(n+1)
	oData := align4(oDataEntry + 16*(n+1))

	// 数据区：GRPICONDIR 在前，随后是各 RT_ICON 位图。
	var dataBuf bytes.Buffer
	dataOff := make([]uint32, n+1)
	dataOff[n] = uint32(oData)
	dataBuf.Write(group)
	for i, ic := range icons {
		for (oData+dataBuf.Len())%4 != 0 {
			dataBuf.WriteByte(0)
		}
		dataOff[i] = uint32(oData + dataBuf.Len())
		dataBuf.Write(ic.data)
	}

	buf := make([]byte, oData)
	copy(buf[oTop:], directory([]dirEntry{
		{3, uint32(oIconType), true},   // RT_ICON
		{14, uint32(oGroupType), true}, // RT_GROUP_ICON
	}))
	iconEntries := make([]dirEntry, n)
	for i := range iconEntries {
		iconEntries[i] = dirEntry{uint32(i + 1), uint32(oLang + 24*i), true}
	}
	copy(buf[oIconType:], directory(iconEntries))
	copy(buf[oGroupType:], directory([]dirEntry{{1, uint32(oLang + 24*n), true}}))
	relocs := make([]uint32, 0, n+1)
	for i := 0; i < n+1; i++ {
		copy(buf[oLang+24*i:], directory([]dirEntry{{0x0409, uint32(oDataEntry + 16*i), false}}))
		p := oDataEntry + 16*i
		le.PutUint32(buf[p:], dataOff[i])
		size := len(group)
		if i < n {
			size = len(icons[i].data)
		}
		le.PutUint32(buf[p+4:], uint32(size))
		relocs = append(relocs, uint32(p))
	}
	return append(buf, dataBuf.Bytes()...), relocs
}

// syso 生成 Go 链接器可识别的 COFF 对象：一个 .rsrc 段 + 指向它的 ADDR32NB 重定位。
func syso(machine, relocType uint16, res []byte, relocs []uint32) []byte {
	ptrReloc := 60 + len(res)
	ptrSym := ptrReloc + 10*len(relocs)
	buf := make([]byte, ptrSym+18+4)
	le.PutUint16(buf[0:], machine)
	le.PutUint16(buf[2:], 1) // NumberOfSections
	le.PutUint32(buf[8:], uint32(ptrSym))
	le.PutUint32(buf[12:], 1) // NumberOfSymbols
	copy(buf[20:28], ".rsrc\x00\x00\x00")
	le.PutUint32(buf[28:], uint32(len(res))) // VirtualSize
	le.PutUint32(buf[36:], uint32(len(res))) // SizeOfRawData
	le.PutUint32(buf[40:], 60)               // PointerToRawData
	le.PutUint32(buf[44:], uint32(ptrReloc))
	le.PutUint16(buf[52:], uint16(len(relocs)))
	le.PutUint32(buf[56:], 0x40000040) // CNT_INITIALIZED_DATA | MEM_READ
	copy(buf[60:], res)
	for i, va := range relocs {
		p := ptrReloc + 10*i
		le.PutUint32(buf[p:], va)
		le.PutUint32(buf[p+4:], 0) // 符号 0 = .rsrc 段
		le.PutUint16(buf[p+8:], relocType)
	}
	copy(buf[ptrSym:ptrSym+5], ".rsrc")
	le.PutUint16(buf[ptrSym+12:], 1) // SectionNumber
	buf[ptrSym+16] = 3               // IMAGE_SYM_CLASS_STATIC
	le.PutUint32(buf[ptrSym+18:], 4) // 字符串表长度（无长符号名）
	return buf
}

func projectRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("未找到 go.mod，请在项目根目录运行")
		}
		dir = parent
	}
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "mkicon:", err)
		os.Exit(1)
	}
}

func main() {
	root, err := projectRoot()
	must(err)
	icons := make([]icon, 0, 6)
	for _, s := range []int{16, 32, 48, 64, 128, 256} {
		icons = append(icons, icon{s, dib(render(s, false))})
	}
	web := filepath.Join(root, "web")
	must(os.WriteFile(filepath.Join(web, "favicon.svg"), []byte(svg()), 0o644))
	must(writeICO(filepath.Join(web, "favicon.ico"), icons))
	must(writePNG(filepath.Join(web, "apple-touch-icon.png"), render(180, true)))
	res, relocs := buildResource(icons)
	must(os.WriteFile(filepath.Join(root, "rsrc_windows_amd64.syso"), syso(0x8664, 0x0003, res, relocs), 0o644)) // AMD64 / ADDR32NB
	must(os.WriteFile(filepath.Join(root, "rsrc_windows_arm64.syso"), syso(0xaa64, 0x0002, res, relocs), 0o644)) // ARM64 / ADDR32NB
	fmt.Println("已生成 web/favicon.svg, web/favicon.ico, web/apple-touch-icon.png, rsrc_windows_{amd64,arm64}.syso")
}
