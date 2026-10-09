import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const sharedColormap = new THREE.TextureLoader().load( 'models/Textures/colormap.png' );
sharedColormap.colorSpace = THREE.SRGBColorSpace;
sharedColormap.flipY = false;

class SharedColorMapPlugin {

	constructor( parser ) {

		this.parser = parser;
		this.name = 'SHARED_COLORMAP';

	}

	loadTexture( textureIndex ) {

		const json = this.parser.json;
		const textureDef = json.textures[ textureIndex ];
		const sourceDef = json.images[ textureDef.source ];

		if ( sourceDef.uri === 'Textures/colormap.png' ) {

			return Promise.resolve( sharedColormap );

		}

		return null;

	}

}

export class ColorMapGLTFLoader extends GLTFLoader {

	constructor( manager ) {

		super( manager );
		this.register( ( parser ) => new SharedColorMapPlugin( parser ) );

	}

}
